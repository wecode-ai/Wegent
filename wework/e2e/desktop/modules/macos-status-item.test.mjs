import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectBeforeStart, inspectRunningApp } from './inspect-before-start.mjs'
import { assertMacosStatusItem, hostedStatusItem } from './macos-status-item.mjs'
import { nativeTrayStateScript } from './native-tray-state.mjs'
import { PROBE_QUIT_SCRIPT } from './upgrade-startup-probe.mjs'

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
    const guid = 'be5fbeec-e1ee-4312-bf16-196d25fa44ce'
    const icon = new URL('../../../resources/icons/tray-rounded.png', import.meta.url).pathname
    await writeFile(
      entry,
      `
    const {app,Tray,nativeImage}=require('electron')
    ${PROBE_QUIT_SCRIPT}
    app.setPath('userData', ${JSON.stringify(join(root, 'user-data'))})
    app.whenReady().then(() => {
      globalThis.nativeTray = new Tray(nativeImage.createFromPath(${JSON.stringify(icon)}).resize({width:18,height:18}), ${JSON.stringify(guid)})
      setImmediate(() => console.log('native-tray-ready'))
    })
  `
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
    const child = spawn(require('electron'), ['--inspect-brk=127.0.0.1:0', entry], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = once(child, 'exit')
    const ready = once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
    try {
      const endpoint = await inspectBeforeStart(child, 'void 0')
      await ready
      const port = new URL(endpoint).port
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
    } finally {
      child.kill('SIGKILL')
      await exited
      await rm(root, { recursive: true, force: true })
    }
  }
)
