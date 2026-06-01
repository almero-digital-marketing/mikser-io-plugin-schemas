// mikser-io-plugin-schemas
//
// Zod-backed entity validation for mikser-io. Schemas live as plain .js
// modules in `schemas/` — one per layout — and validate the `meta`
// front-matter of every loaded entity that uses that layout. A
// TypeScript declaration file is regenerated on every build so SDK
// consumers get typed access to entity meta.
//
// Layout matching:
//   schemas/article.js  →  entities where meta.layout === 'article'
//
// Configuration:
//   schemas: {
//       schemasFolder: 'schemas',        // default
//       typesFile:     'entities.d.ts',  // emitted at workingFolder root
//       onError:       'warn',           // 'warn' | 'fail' | 'off'
//       layoutKey:     'meta.layout',    // dotted path to the layout name
//   }
//
// Behavior:
//   - 'warn' (default): log validation errors, leave the entity in the
//     catalog. Right for migrating an existing project; loud enough to
//     notice, soft enough to not block deploys.
//   - 'fail': any validation error throws — the entity is marked invalid
//     by the lifecycle and the build surfaces a non-zero exit.
//   - 'off':  validate nothing. Schemas still load (so the .d.ts emit
//     still runs) but entity contents are not checked. Useful when types
//     are the only thing you care about.
//
// Reference handling:
//   References between entities are plain href strings (see
//   mikser-io-sdk-vue's useDocument / useHref). A schema field for a
//   reference is just z.string() — no special reference type. This keeps
//   schemas portable and avoids coupling the validation layer to the
//   resolution layer.

import path from 'node:path'
import { mkdir, readdir } from 'node:fs/promises'
import _ from 'lodash'
import { writeTypes } from './src/typegen.js'

// Friendly per-issue messages — overrides Zod's defaults for the cases
// where Zod's wording is technically correct but reads awkwardly for
// people editing markdown. Returning `{ message }` overrides for that
// issue; falling through to ctx.defaultError keeps Zod's text.
//
// String codes (not zod's ZodIssueCode imports) so the plugin keeps
// zod as a peer dependency with no direct require — every schema
// already brings its own zod.
function friendlyErrorMap(issue, ctx) {
    switch (issue.code) {
        case 'invalid_type':
            if (issue.received === 'undefined') return { message: 'is missing' }
            return { message: `expected ${issue.expected}, got ${issue.received}` }
        case 'too_small':
            if (issue.type === 'string') return { message: `is too short (min ${issue.minimum} chars)` }
            if (issue.type === 'number') return { message: `is too small (min ${issue.minimum})` }
            if (issue.type === 'array')  return { message: `needs at least ${issue.minimum} item${issue.minimum === 1 ? '' : 's'}` }
            break
        case 'too_big':
            if (issue.type === 'string') return { message: `is too long (max ${issue.maximum} chars)` }
            if (issue.type === 'number') return { message: `is too large (max ${issue.maximum})` }
            if (issue.type === 'array')  return { message: `has too many items (max ${issue.maximum})` }
            break
        case 'invalid_string':
            if (issue.validation === 'email') return { message: 'is not a valid email' }
            if (issue.validation === 'url')   return { message: 'is not a valid URL' }
            if (issue.validation === 'uuid')  return { message: 'is not a valid UUID' }
            if (issue.validation === 'regex') return { message: 'does not match the required pattern' }
            break
        case 'invalid_enum_value':
            return { message: `must be one of: ${(issue.options ?? []).join(', ')}` }
        case 'unrecognized_keys': {
            const keys = issue.keys ?? []
            return { message: `unknown field${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}` }
        }
        case 'invalid_union':
        case 'invalid_union_discriminator':
            return { message: 'does not match any expected shape' }
    }
    return { message: ctx.defaultError }
}

export default ({
    runtime,
    onLoaded,
    onValidate,
    onFinalized,
    onSync,
    watch,
    useLogger,
    matchEntity,
    constants: { OPERATION, ACTION },
}) => {
    const collection = 'schemas'
    const type = 'schema'

    // layout name → { name, schema, source, revision }
    const schemas = {}

    // Generated .d.ts gets stamped from a stable journal-of-edits, not
    // wall-clock time — wrote() flips true on any schema-folder sync so
    // onFinalized knows it needs to re-emit.
    let dirty = true

    function getLayout(entity, layoutKey) {
        return _.get(entity, layoutKey)
    }

    // Load (or reload) a single schema file. Used both for the initial
    // folder scan in onLoaded and for live onSync CREATE/UPDATE events.
    // Returns true on successful load (caller can flip `dirty`).
    async function loadSchemaFile(name, source) {
        const logger = useLogger()
        try {
            const mod = await import(`${source}?stamp=${Date.now()}`)
            const schema = mod.default
            if (!schema || typeof schema.safeParse !== 'function') {
                logger.error(
                    'Schema %s: default export is not a Zod schema (no safeParse method)',
                    name,
                )
                return false
            }
            schemas[name] = { name, schema, source, revision: mod.revision ?? 1 }
            dirty = true
            logger.info('Schema loaded: %s', name)
            return true
        } catch (err) {
            logger.error('Schema %s: load failed: %s', name, err.message)
            return false
        }
    }

    onLoaded(async () => {
        const logger = useLogger()
        const config = runtime.config.schemas ?? {}

        runtime.options.schemas = config.schemasFolder || collection
        runtime.options.schemasFolder = path.join(
            runtime.options.workingFolder,
            runtime.options.schemas,
        )
        runtime.options.schemasTypesFile = path.join(
            runtime.options.workingFolder,
            config.typesFile || 'entities.d.ts',
        )

        await mkdir(runtime.options.schemasFolder, { recursive: true })
        logger.info('Schemas folder: %s', runtime.options.schemasFolder)
        logger.info('Schemas types:  %s', runtime.options.schemasTypesFile)

        // Initial scan — load every existing schema file. Chokidar (started
        // by watch() below) defaults to ignoreInitial: true and only runs
        // in --watch mode at all, so without this loop a cold start would
        // silently ignore every schema already on disk.
        const entries = await readdir(runtime.options.schemasFolder, { withFileTypes: true })
        const schemaFiles = entries
            .filter(entry => entry.isFile())
            .filter(entry => entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))
        for (const entry of schemaFiles) {
            const name = entry.name.replace(path.extname(entry.name), '')
            const source = path.join(runtime.options.schemasFolder, entry.name)
            await loadSchemaFile(name, source)
        }

        watch(collection, runtime.options.schemasFolder)
    })

    // Discover schema modules. Each file in schemasFolder becomes one
    // schema keyed by its filename stem ('article.js' → 'article').
    // The default export must be a Zod schema (anything with a
    // `.safeParse()` method is treated as one — we don't `instanceof`
    // ZodType so users can pass a `.refine(...)`/`.transform(...)` chain
    // or even a custom validator with a safeParse-shaped surface).
    //
    // onSync fires from chokidar events after the initial scan. Files
    // already on disk at startup are picked up by the readdir loop in
    // onLoaded.
    onSync(collection, async ({ action, context }) => {
        if (!context.relativePath) return false
        const { relativePath } = context
        if (!relativePath.endsWith('.js') && !relativePath.endsWith('.mjs')) return false

        const logger = useLogger()
        const name = relativePath.replace(path.extname(relativePath), '')
        const source = path.join(runtime.options.schemasFolder, relativePath)

        switch (action) {
            case ACTION.CREATE:
            case ACTION.UPDATE: {
                await loadSchemaFile(name, source)
                return true
            }
            case ACTION.DELETE: {
                if (schemas[name]) {
                    delete schemas[name]
                    dirty = true
                    logger.info('Schema removed: %s', name)
                }
                return true
            }
        }
        return false
    })

    // Validate per-entity on CREATE/UPDATE. Returning a string surfaces
    // it as a validator warning via mikser's onValidate semantics;
    // throwing fails the entry. Mode picked from runtime.config.schemas.onError.
    onValidate([OPERATION.CREATE, OPERATION.UPDATE], async entry => {
        const config = runtime.config.schemas ?? {}
        const mode = config.onError ?? 'warn'
        if (mode === 'off') return

        const layoutKey = config.layoutKey || 'meta.layout'
        const entity = entry.entity
        if (!entity || !entity.meta) return

        const layout = getLayout(entity, layoutKey)
        if (!layout) return

        const definition = schemas[layout]
        if (!definition) return                 // no schema for this layout — silently skip

        const result = definition.schema.safeParse(entity.meta, { errorMap: friendlyErrorMap })
        if (result.success) return

        // Multi-line message: one issue per line, source identified up
        // front. Logs and thrown errors both render this readably; an
        // editor scanning the log can spot exactly which file + which
        // field needs attention. Single-line variant felt cramped on
        // docs with several violations.
        const sourceId = entity.id || '<unknown source>'
        const lines = result.error.issues
            .map(i => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        const message = `schema(${layout}) ${sourceId}:\n${lines.join('\n')}`

        if (mode === 'fail') {
            throw new Error(message)
        }
        return message                          // 'warn' — surfaces via mikser's logger
    })

    // Regenerate the .d.ts at the end of every build. Idempotent — only
    // rewrites if something actually changed in the schemas map.
    onFinalized(async () => {
        if (!dirty) return
        const logger = useLogger()
        try {
            await writeTypes({
                schemas,
                outputPath: runtime.options.schemasTypesFile,
            })
            dirty = false
            logger.info(
                'Schemas types emitted: %d layouts → %s',
                Object.keys(schemas).length,
                runtime.options.schemasTypesFile,
            )
        } catch (err) {
            logger.error('Schemas types emit failed: %s', err.message)
        }
    })

    return { collection, type }
}
