import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { routeUpgradeRequests } from './upgrade-request-route.mjs'

const require = createRequire(new URL('../../../electron/package.json', import.meta.url))

test('routes the default update URL through the real Electron network stack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-upgrade-transport-'))
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.end('real loopback transport')
  })
  let child
  let output = ''
  let errors = ''
  try {
    await new Promise(accept => server.listen(0, '127.0.0.1', accept))
    await mkdir(join(root, 'app'))
    await writeFile(
      join(root, 'app/package.json'),
      JSON.stringify({ name: 'wework-upgrade-transport-test', main: 'main.cjs' })
    )
    await writeFile(
      join(root, 'app/main.cjs'),
      `
      const {app,net} = require('electron')
      app.setPath('userData', ${JSON.stringify(join(root, 'user-data'))})
      app.whenReady().then(async () => {
        const response = await net.fetch('https://github.com/wecode-ai/Wegent/releases/download/wework-updater/components-beta-macos-arm64.json')
        console.log('TRANSPORT_RESULT=' + await response.text())
        app.quit()
      }).catch(error => {console.error(error);app.exit(1)})
    `
    )
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), ['--inspect-brk=127.0.0.1:0', join(root, 'app')], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      errors += chunk
    })
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(20_000) })
    await routeUpgradeRequests(child, `http://127.0.0.1:${server.address().port}`)
    assert.deepEqual(await exited, [0, null], errors)
    assert.ok(output.includes('TRANSPORT_RESULT=real loopback transport'), output)
    assert.deepEqual(requests, ['/components-beta-macos-arm64.json'])
  } catch (error) {
    console.error('Isolated Electron startup diagnostics:', {
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
      stdout: output,
      stderr: errors,
    })
    throw error
  } finally {
    child?.kill()
    server.closeAllConnections()
    await new Promise(accept => server.close(accept))
    await rm(root, { recursive: true, force: true })
  }
})
