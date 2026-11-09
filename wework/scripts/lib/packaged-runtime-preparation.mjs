import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { upgradeUserEnvironment } from '../../e2e/desktop/modules/upgrade-user-environment.mjs'

/** Prepare immutable programs with the delivered target while source inputs load. */
export async function preparePackagedRuntimeCache({ target, directory, immutableRoot }) {
  const started = performance.now()
  const module = pathToFileURL(
    join(target.resources, 'app.asar/dist/runtime/bundled-runtime-materializer.js')
  ).href
  const catalog = join(directory, 'private-runtimes')
  const script = join(directory, 'prepare-target-programs.mjs')
  await writeFile(
    script,
    `
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { materializeBundledRuntimes } from ${JSON.stringify(module)}
await materializeBundledRuntimes(
  ${JSON.stringify(join(target.resources, 'harness-runtime'))}, ${JSON.stringify(catalog)},
  ['core', 'workbench'], {
    immutableRoot: ${JSON.stringify(immutableRoot)},
    fetch: async () => { throw new Error('Delivered runtime preparation must not download programs') },
  }
)
const shared = await realpath(${JSON.stringify(immutableRoot)})
const { runtimes } = JSON.parse(await readFile(${JSON.stringify(join(target.resources, 'harness-runtime/runtimes.json'))}, 'utf8'))
assert.deepEqual(new Set(runtimes.map(item => item.role)), new Set(['core', 'workbench']))
for (const runtime of runtimes.filter(item => ['core', 'workbench'].includes(item.role)))
  assert.equal(dirname(await realpath(join(${JSON.stringify(catalog)}, runtime.sourceFingerprint))), shared)
`
  )
  await promisify(execFile)(target.executable, [script], {
    env: { ...upgradeUserEnvironment(process.env, directory), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 300_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  console.log(
    JSON.stringify({
      event: 'target-runtime-cache-ready',
      version: target.version,
      sourceSha: target.sourceSha,
      archiveSha256: target.sha256,
      elapsedMs: Math.round(performance.now() - started),
    })
  )
  return catalog
}
