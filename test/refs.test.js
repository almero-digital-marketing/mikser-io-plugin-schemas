// Reference validation.
//
// `refExists` decides whether a `$`-ref resolves to something in the
// catalog, and it had two independent faults that cancelled into
// "everything passes":
//
//   1. It must match all four forms core resolves a ref by — id,
//      meta.href, meta.url, id-minus-extension. Omitting `meta.url`, the
//      served path (ADR-0011) that `$hero: /hero.jpg` resolves through,
//      reports a valid asset reference as broken, and under
//      onError: 'fail' that fails the build.
//
//   2. The filter it passes must be one the catalog can apply. A
//      function forces a full scan, and on mikser-io < 9.19.0 it was
//      discarded outright — the SQL translation reports "nothing left to
//      check" for a filter it cannot read — so the call answers with the
//      entire catalog and `matches.length > 0` is true for any ref.
//
// The second masks the first: with every ref passing, a false negative
// cannot be observed. Both are delegated to core's refFilter, so one
// definition of the relation serves both directions.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runtime, refFilter, findEntity, findEntities } from 'mikser-io'
import { createHarness } from 'mikser-io/testing/harness.js'
import { schemas } from '../index.js'

// Entities covering every form a ref can name. The served-path one is
// the case that was broken.
const CATALOG = [
    { id: '/documents/authors/dick.md', collection: 'documents', meta: { href: '/authors/dick' } },
    { id: '/documents/about.md',        collection: 'documents', meta: {} },
    { id: '/files/img/hero.jpg',        collection: 'files',     meta: { url: '/img/hero.jpg' } },
]

async function withHarness(entities, fn) {
    const root = await mkdtemp(path.join(tmpdir(), 'mikser-schemas-'))
    await mkdir(path.join(root, 'schemas'), { recursive: true })
    try {
        const harness = createHarness({
            entities,
            options: { workingFolder: root },
        })
        schemas({ schemaKey: 'meta.layout' })(harness.core)
        await harness.runHook('loaded')
        return await fn(harness, root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe('ref resolution forms', () => {
    it('resolves every form core resolves', async () => {
        await withHarness(CATALOG, async () => {
            // Asserted through core's own resolver, which refExists now
            // delegates to — the point being that there is one definition.
            for (const ref of [
                '/documents/authors/dick.md',   // id
                '/authors/dick',                // meta.href
                '/documents/about',             // id minus extension
                '/img/hero.jpg',                // meta.url — the served path
            ]) {
                assert.ok(
                    await findEntity(refFilter(ref)),
                    `refFilter should resolve ${ref}`,
                )
            }
            assert.equal(await findEntity(refFilter('/nope')), undefined)
        })
    })

    it('a function filter is applied, not discarded', async () => {
        // The core regression that made this check vacuous. Guarding it
        // here as well as in core, because this package is what the
        // symptom surfaced through.
        await withHarness(CATALOG, async () => {
            const miss = await findEntities(e => e.id === '/definitely/not/here.md')
            assert.deepEqual(miss, [], 'a non-matching predicate must return nothing')
            const hit = await findEntities(e => e.id === '/documents/about.md')
            assert.equal(hit.length, 1)
        })
    })
})

describe('missing-reference detection', () => {
    it('reports a ref that resolves to nothing', async () => {
        await withHarness([
            ...CATALOG,
            { id: '/documents/post.md', collection: 'documents', meta: { $author: '/authors/nobody' } },
        ], async (h) => {
            await h.runHook('finalized')
            const warned = h.logs
                .filter(l => l.level === 'warn')
                .map(l => l.args.join(' '))
                .join('\n')
            assert.match(warned, /\/authors\/nobody/,
                'an unresolvable ref must be reported')
        })
    })

    it('does NOT report a ref that resolves by served path', async () => {
        // The false positive: /img/hero.jpg resolves via meta.url at
        // render time, and was reported as broken here.
        await withHarness([
            ...CATALOG,
            { id: '/documents/post.md', collection: 'documents', meta: { $hero: '/img/hero.jpg' } },
        ], async (h) => {
            await h.runHook('finalized')
            const warned = h.logs
                .filter(l => l.level === 'warn')
                .map(l => l.args.join(' '))
                .join('\n')
            assert.doesNotMatch(warned, /hero\.jpg/,
                'a ref resolving through meta.url must not be reported broken')
        })
    })

    it('does not report refs that resolve by id or href', async () => {
        await withHarness([
            ...CATALOG,
            {
                id: '/documents/post.md', collection: 'documents',
                meta: { $author: '/authors/dick', $about: '/documents/about' },
            },
        ], async (h) => {
            await h.runHook('finalized')
            const warned = h.logs.filter(l => l.level === 'warn').map(l => l.args.join(' ')).join('\n')
            assert.doesNotMatch(warned, /does not resolve/)
        })
    })
})
