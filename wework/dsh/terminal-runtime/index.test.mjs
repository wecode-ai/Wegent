import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function isolatedPlugin(t, nativeSource) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-terminal-plugin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all(
    ['index.js', 'terminal-runtime.js', 'sse-events.js'].map(name =>
      copyFile(new URL(name, import.meta.url), join(directory, name))
    )
  )
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  const dependency = join(directory, 'node_modules', 'node-pty')
  await mkdir(dependency, { recursive: true })
  await writeFile(join(dependency, 'package.json'), '{"main":"index.cjs"}')
  await writeFile(join(dependency, 'index.cjs'), nativeSource)
  return directory
}

const exerciseRoutes = `
  import assert from 'node:assert/strict'
  import { Readable } from 'node:stream'
  const { apply } = await import('./index.js')
  assert.equal(globalThis.nativeLoads, undefined)
  const routes = new Map()
  const cleanups = []
  apply({
    effect(install) { cleanups.push(install()) },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
  })
  assert.equal(routes.size, 3)
  assert.equal(globalThis.nativeLoads, undefined)
  async function request(path, method, body) {
    const req = Readable.from(body ? [JSON.stringify(body)] : [])
    Object.assign(req, { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } })
    let status, result
    await routes.get(path)(req, { writeHead(value) { status = value }, end(value) { result = JSON.parse(value) } })
    return { status, result }
  }
  const description = await request('/wework/terminal/v1', 'GET')
  assert.equal(description.status, 200)
  assert.equal(description.result.activeSessions, 0)
  assert.equal(globalThis.nativeLoads, undefined)
`

function runFixture(directory, script) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr)
}

test('registers terminal routes before loading PTY and shares the native module across starts', async t => {
  const directory = await isolatedPlugin(
    t,
    `globalThis.nativeLoads = (globalThis.nativeLoads || 0) + 1
     exports.spawn = () => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill() { globalThis.nativeKills = (globalThis.nativeKills || 0) + 1 } })`
  )
  runFixture(
    directory,
    `${exerciseRoutes}
    for (const session_id of ['first', 'second']) {
      const started = await request('/wework/terminal/v1/rpc', 'POST', { method: 'terminal.start', params: { session_id, cwd: process.cwd() } })
      assert.equal(started.status, 200)
      assert.equal(started.result.result.session_id, session_id)
      assert.equal(globalThis.nativeLoads, 1)
    }
    cleanups.reverse().forEach(cleanup => cleanup())
    assert.equal(globalThis.nativeKills, 2)
  `
  )
})

test('propagates native loading failure through the existing terminal spawn error response', async t => {
  const directory = await isolatedPlugin(t, "throw new Error('native-unavailable')")
  runFixture(
    directory,
    `${exerciseRoutes}
    const started = await request('/wework/terminal/v1/rpc', 'POST', { method: 'terminal.start', params: { session_id: 'failed', cwd: process.cwd() } })
    assert.equal(started.status, 500)
    assert.equal(started.result.error.code, 'spawn_failed')
    assert.equal(started.result.error.message, 'native-unavailable')
    cleanups.reverse().forEach(cleanup => cleanup())
  `
  )
})
