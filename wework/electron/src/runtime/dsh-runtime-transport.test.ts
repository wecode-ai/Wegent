import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { afterEach, expect, test } from 'vitest'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function runtimeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wework-dsh-transport-'))
  roots.push(root)
  await mkdir(join(root, 'runtime'))
  await mkdir(join(root, 'host'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  // Exercise the current production modules in a separate process; no compiled
  // application, existing profile, or global network dispatcher is reused.
  for (const name of [
    'runtime/dsh-runtime',
    'runtime/runtime-supervisor',
    'runtime/rotating-log',
    'runtime/spawn-command',
    'host/lazy-cloud-fetch',
    'host/cloud-http',
  ]) {
    const source = await readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8')
    const { outputText } = transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
    })
    await writeFile(join(root, `${name}.js`), outputText)
  }
  await writeFile(
    join(root, 'loopback-fetch.mjs'),
    await readFile(new URL('../../test/fixtures/loopback-fetch.mjs', import.meta.url), 'utf8')
  )
  const electron = join(root, 'node_modules/electron')
  await mkdir(electron, { recursive: true })
  await writeFile(join(electron, 'package.json'), '{"type":"module","exports":"./index.js"}')
  await writeFile(
    join(electron, 'index.js'),
    `import assert from 'node:assert/strict'
     import { loopbackFetch } from '../../loopback-fetch.mjs'
     export const net = { fetch(url, init) {
       assert.equal(init.credentials, 'omit')
       assert.ok(init.signal instanceof AbortSignal)
       globalThis.probeRequests.push(url)
       return loopbackFetch(url, init)
     } }
     export const session = { defaultSession: { fetch() {
       throw new Error('An anonymous probe must not enter the authenticated session')
     } } }
    `
  )
  return root
}

test.each(['external', 'managed'])(
  'the real %s runtime uses Chromium transport when Node fetch is unavailable',
  async mode => {
    const root = await runtimeFixture()
    const script = `
      import assert from 'node:assert/strict'
      import { createServer } from 'node:http'
      import { DshRuntime } from './runtime/dsh-runtime.js'
      globalThis.probeRequests = []
      globalThis.fetch = () => { throw new Error('DSH readiness reached Node fetch') }
      const mode = process.argv[1]
      let server
      let runtime
      if (mode === 'external') {
        server = createServer((_request, response) => response.end('ready'))
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        runtime = new DshRuntime({url: 'http://127.0.0.1:' + server.address().port})
      } else {
        runtime = new DshRuntime({
          url: 'http://127.0.0.1:0', command: process.execPath, startTimeoutMs: 2000,
          args: ['-e', "const s = require('node:http').createServer((q,r) => r.end('ready')); s.listen(0,'127.0.0.1',() => console.log('dsh web: http://127.0.0.1:' + s.address().port))"]
        })
      }
      try {
        await runtime.start(2000)
        assert.equal(globalThis.probeRequests.length, 1)
        assert.equal(globalThis.probeRequests[0], new URL(runtime.url()).href)
        if (mode === 'managed') assert.ok(runtime.pid() > 0)
        console.log('CHROMIUM_DSH_PROBE_OK')
      } finally {
        await runtime.stop()
        if (server) await new Promise(resolve => server.close(resolve))
      }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, mode], {
      cwd: root,
      encoding: 'utf8',
      timeout: 4_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('CHROMIUM_DSH_PROBE_OK')
  }
)
