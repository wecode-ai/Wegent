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
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  // Exercise the current production modules in a separate process; no compiled
  // application, existing profile, or global network dispatcher is reused.
  for (const name of [
    'runtime/dsh-runtime',
    'runtime/http-readiness-probe',
    'runtime/runtime-supervisor',
    'runtime/rotating-log',
    'runtime/spawn-command',
  ]) {
    const source = await readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8')
    const { outputText } = transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
    })
    await writeFile(join(root, `${name}.js`), outputText)
  }
  return root
}

test.each(['external', 'managed'])(
  'the real %s runtime runs in a bare Node host without Electron or Node fetch',
  async mode => {
    const root = await runtimeFixture()
    const script = `
      import assert from 'node:assert/strict'
      import { createServer } from 'node:http'
      import { DshRuntime } from './runtime/dsh-runtime.js'
      globalThis.fetch = () => { throw new Error('DSH readiness reached Node fetch') }
      const mode = process.argv[1]
      let server
      let runtime
      if (mode === 'external') {
        server = createServer((request, response) => {
          assert.equal(request.headers.cookie, undefined)
          assert.equal(request.headers.authorization, undefined)
          response.end('ready')
        })
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        runtime = new DshRuntime({url: 'http://127.0.0.1:' + server.address().port})
      } else {
        runtime = new DshRuntime({
          url: 'http://127.0.0.1:0', command: process.execPath, startTimeoutMs: 2000,
          args: ['-e', "const assert = require('node:assert/strict'); const s = require('node:http').createServer((q,r) => { assert.equal(q.headers.cookie, undefined); assert.equal(q.headers.authorization, undefined); r.end('ready') }); s.listen(0,'127.0.0.1',() => console.log('dsh web: http://127.0.0.1:' + s.address().port))"]
        })
      }
      try {
        await runtime.start(2000)
        if (mode === 'managed') assert.ok(runtime.pid() > 0)
        console.log('BARE_NODE_DSH_PROBE_OK')
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
    expect(result.stdout).toContain('BARE_NODE_DSH_PROBE_OK')
  }
)
