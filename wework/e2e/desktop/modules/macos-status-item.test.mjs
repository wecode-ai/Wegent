import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { inspectRunningApp, readInspectorEndpoint } from './inspect-before-start.mjs'
import { assertMacosStatusItem, hostedStatusItem } from './macos-status-item.mjs'
import { nativeTrayStateScript } from './native-tray-state.mjs'
import { captureStartupNativeStack, PROBE_QUIT_SCRIPT } from './upgrade-startup-probe.mjs'

test('status item hosting requires a finite positive native window inside its display', () => {
  const display = { x: -1440, y: 0, width: 1440, height: 900 }
  const bounds = { x: -300, y: 0, width: 22, height: 30 }
  assert.equal(hostedStatusItem({ bounds, display }), true)
  for (const invalid of [{ width: 0 }, { height: 0 }, { x: 1 }, { y: -1 }, { width: NaN }])
    assert.equal(hostedStatusItem({ bounds: { ...bounds, ...invalid }, display }), false)
})

test(
  'delivered native tray inspection rejects another PID, another GUID and a destroyed item',
  { skip: process.platform !== 'darwin', timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-native-status-item-'))
    const entry = join(root, 'main.cjs')
    const trace = join(root, 'startup.jsonl')
    const guid = 'be5fbeec-e1ee-4312-bf16-196d25fa44ce'
    const icon = new URL('../../../resources/icons/tray-rounded.png', import.meta.url).pathname
    await writeFile(
      entry,
      `
    const {app,Tray,nativeImage}=require('electron')
    ${PROBE_QUIT_SCRIPT}
    const mark = phase => require('node:fs').appendFileSync(
      ${JSON.stringify(trace)}, JSON.stringify({phase,pid:process.pid,time:Date.now(),ready:app.isReady()}) + '\\n'
    )
    process.on('uncaughtExceptionMonitor', error => {
      console.error(error)
      mark('uncaught-exception')
    })
    mark('entry')
    app.setPath('userData', ${JSON.stringify(join(root, 'user-data'))})
    app.once('will-finish-launching', () => mark('will-finish-launching'))
    globalThis.nativeTrayReady = app.whenReady().then(() => {
      mark('ready')
      globalThis.nativeTray = new Tray(nativeImage.createFromPath(${JSON.stringify(icon)}).resize({width:18,height:18}), ${JSON.stringify(guid)})
      mark('tray-created')
      return true
    })
    mark('ready-handler-registered')
    console.log('ready-handler-registered')
  `
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
    const child = spawn(require('electron'), ['--inspect=127.0.0.1:0', entry], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = once(child, 'exit')
    console.log('Native tray probe started:', { pid: child.pid, time: Date.now() })
    let stderr = ''
    child.stderr.on('data', chunk => (stderr = (stderr + chunk).slice(-8192)))
    const output = createInterface({ input: child.stdout })
    const registered = once(output, 'line', { signal: AbortSignal.timeout(10_000) }).catch(
      cause => {
        throw new Error('Electron did not register the native tray ready handler', { cause })
      }
    )
    try {
      const [endpoint, [phase]] = await Promise.all([readInspectorEndpoint(child), registered])
      assert.equal(phase, 'ready-handler-registered')
      const port = new URL(endpoint).port
      assert.equal(await inspectRunningApp(port, child.pid, 'globalThis.nativeTrayReady'), true)
      console.log('Native tray probe ready:', await readFile(trace, 'utf8'))
      const read = value => inspectRunningApp(port, child.pid, nativeTrayStateScript(value))
      await assertMacosStatusItem(
        {
          async command() {
            return JSON.stringify({ created: true, guid })
          },
        },
        child.pid,
        root,
        'probe',
        port
      )
      const state = await read(guid)
      assert.equal(state.pid, child.pid)
      assert.equal(state.items.length, 1)
      assert.equal(hostedStatusItem(state.items[0]), true)
      assert.deepEqual((await read('different-guid')).items, [])
      await assert.rejects(
        inspectRunningApp(port, child.pid + 1, nativeTrayStateScript(guid)),
        /another release process/
      )
      await inspectRunningApp(port, child.pid, 'globalThis.nativeTray.destroy()')
      assert.deepEqual((await read(guid)).items, [])
    } catch (error) {
      await captureStartupNativeStack(child)
      console.error('Native tray probe diagnostics:', {
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stderr,
        statusItem: await readFile(
          join(root, 'macos-status-item-probe-failure.json'),
          'utf8'
        ).catch(error => error.code),
        startup: await readFile(trace, 'utf8').catch(error => error.code),
      })
      throw error
    } finally {
      output.close()
      child.kill('SIGKILL')
      await exited
      await rm(root, { recursive: true, force: true })
    }
  }
)
