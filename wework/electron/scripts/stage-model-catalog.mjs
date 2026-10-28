import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Reuse the renderer's pure matcher and catalog assets in the independent Host workspace.
// Inline JSON as typed constants so the Host does not need a second package or JSON loader.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourcePath = resolve(root, 'packages/chat-core/src/codex-catalog.ts')
let source = await readFile(sourcePath, 'utf8')
const imports = [...source.matchAll(/^import (\w+) from '([^']+\.json)'$/gm)]
if (imports.length === 0) throw new Error('Shared model catalog has no JSON assets')
for (const [statement, name, relative] of imports) {
  const resource = JSON.parse(await readFile(resolve(dirname(sourcePath), relative), 'utf8'))
  source = source.replace(
    statement,
    `const ${name} = ${JSON.stringify(resource)} as CatalogResource`
  )
}
const target = resolve(root, 'wework/electron/src/vendor/model-catalog/catalog.ts')
await mkdir(dirname(target), { recursive: true })
await writeFile(target, source)
