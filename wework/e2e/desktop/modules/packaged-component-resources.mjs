import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/** Inspect the delivered archive through its own verified materializer, outside signed resources. */
export async function packagedComponentRoots({ appBinary, resourcesRoot, components, resultDir }) {
  const roots = Object.fromEntries(
    Object.entries(components)
      .filter(([, component]) => component.path)
      .map(([id, component]) => [id, join(resourcesRoot, component.path)])
  )
  const archived = Object.entries(components).filter(([, component]) => component.archive)
  if (!archived.length) return roots
  const module = pathToFileURL(
    join(resourcesRoot, 'app.asar/dist/runtime/bundled-component-archive.js')
  ).href
  const script = join(resultDir, 'inspect-bundled-components.mjs')
  await writeFile(
    script,
    `
import { materializeBundledComponentArchive } from ${JSON.stringify(module)}
import { join } from 'node:path'
const roots = await Promise.all(${JSON.stringify(archived)}.map(async ([id, component], index) => [
  id,
  await materializeBundledComponentArchive(
    ${JSON.stringify(resourcesRoot)}, join(${JSON.stringify(resultDir)}, 'package-components', String(index)), component.archive, component.sha256
  )
]))
console.log(JSON.stringify(Object.fromEntries(roots)))
`
  )
  const { stdout } = await promisify(execFile)(appBinary, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  return { ...roots, ...JSON.parse(stdout.trim()) }
}
