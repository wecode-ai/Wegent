import assert from 'node:assert/strict'
import { appendFile, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CuaDriver } from '@trycua/cua-driver'

const ACCEPT_LABEL = /^(Open|Select|Select Folder|Choose|Choose Folder|打开|选择|选择文件夹|选取)$/i
const CANCEL_LABEL = /^(Cancel|取消)$/i

export async function createNativeDialogDriver({
  pid,
  resultDir,
  timeoutMs,
  platform = process.platform,
}) {
  const driver = CuaDriver.create(undefined)

  async function call(name, args) {
    const result = await driver.callTool(name, JSON.stringify(args), {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = result.structuredJson ? JSON.parse(result.structuredJson) : null
    if (['click', 'press_key', 'type_text'].includes(name)) {
      await appendFile(
        join(resultDir, 'native-dialog-actions.jsonl'),
        `${JSON.stringify({ at: Date.now(), name, args, result: data, text: result.text })}\n`
      )
    }
    assert.equal(result.isError, false, `${name} failed: ${result.text}`)
    assert.notEqual(data?.effect, 'refused', `${name} was refused: ${result.text}`)
    return { data, images: result.images }
  }

  async function windows() {
    const { data } = await call('list_windows', { pid, on_screen_only: true })
    assert.ok(Array.isArray(data?.windows), 'The native driver did not return a window catalog')
    assert.ok(
      data.windows.every(window => window.pid === pid),
      'The native driver returned another process window'
    )
    await appendFile(
      join(resultDir, 'native-window-catalog.jsonl'),
      `${JSON.stringify({ at: Date.now(), windows: data.windows })}\n`
    )
    return data.windows
  }

  async function snapshot(windowId, evidenceName) {
    const result = await call('get_window_state', {
      pid,
      window_id: windowId,
      include_screenshot: Boolean(evidenceName),
    })
    assert.ok(Array.isArray(result.data?.elements), 'The native window has no accessibility tree')
    if (evidenceName) {
      await writeFile(
        join(resultDir, `${evidenceName}.json`),
        `${JSON.stringify(result.data, null, 2)}\n`
      )
      const png = result.images.find(image => image.mimeType === 'image/png')
      assert.ok(png, 'The native dialog screenshot is missing')
      await writeFile(join(resultDir, `${evidenceName}.png`), Buffer.from(png.dataBase64, 'base64'))
    }
    assert.notEqual(
      result.data.degraded,
      true,
      `The native accessibility tree is degraded: ${result.data.degraded_reason}`
    )
    return result.data
  }

  async function button(windowId, label) {
    const state = await snapshot(windowId)
    const matches = state.elements.filter(
      element => /button/i.test(element.role) && label.test(element.label ?? '')
    )
    assert.equal(matches.length, 1, `Expected one native dialog button matching ${label}`)
    assert.ok(matches[0].element_token, 'The native dialog button has no snapshot token')
    await call('click', {
      pid,
      window_id: windowId,
      element_token: matches[0].element_token,
      delivery_mode: 'foreground',
    })
  }

  async function waitFor(predicate, message) {
    const deadline = Date.now() + timeoutMs
    do {
      const result = await predicate()
      if (result) return result
      await delay(100)
    } while (Date.now() < deadline)
    assert.fail(message)
  }

  async function recordDialogState(windowId, stage) {
    const currentWindows = await windows()
    const open = currentWindows.some(window => window.window_id === windowId)
    await appendFile(
      join(resultDir, 'native-dialog-actions.jsonl'),
      `${JSON.stringify({ at: Date.now(), stage, windowId, open })}\n`
    )
    if (open) await snapshot(windowId, `native-picker-${windowId}-${stage}`)
    return open
  }

  async function dismissDialog(windowId, key, modifiers = []) {
    await call('press_key', {
      pid,
      window_id: windowId,
      key,
      modifiers,
      delivery_mode: 'foreground',
    })
    // A closing GTK dialog can stop servicing AT-SPI before it unmaps. Observe
    // its native window lifecycle instead of walking its tree during teardown.
    await waitFor(
      async () => !(await windows()).some(window => window.window_id === windowId),
      `The native directory dialog did not close after ${[...modifiers, key].join('+')}`
    )
  }

  return {
    windows,
    snapshot,
    async waitForDialog(previousWindows) {
      const previousIds = new Set(previousWindows.map(window => window.window_id))
      return waitFor(async () => {
        const dialogs = (await windows()).filter(window => !previousIds.has(window.window_id))
        assert.ok(dialogs.length <= 1, 'More than one new native window appeared')
        return dialogs[0]?.window_id
      }, 'The project creation entry did not open a real native directory dialog')
    },
    async selectDirectory(windowId, path) {
      await call('press_key', {
        pid,
        window_id: windowId,
        key: platform === 'darwin' ? 'g' : 'l',
        modifiers: platform === 'darwin' ? ['cmd', 'shift'] : ['ctrl'],
        delivery_mode: 'foreground',
      })
      assert.ok(
        await recordDialogState(windowId, 'location-shortcut'),
        'The location shortcut unexpectedly closed the native directory dialog'
      )
      await call('type_text', {
        pid,
        window_id: windowId,
        text: `${path}${sep}`,
        delivery_mode: 'foreground',
      })
      assert.ok(
        await recordDialogState(windowId, 'location-typed'),
        'Typing the fixture path unexpectedly closed the native directory dialog'
      )
      if (platform === 'linux') {
        // Chromium replaces the process ATK root, hiding its GTK chooser's
        // controls from the SDK tree. Activate GTK's standard Open mnemonic;
        // the scenario verifies the actual returned directory in the real UI.
        await dismissDialog(windowId, 'o', ['alt'])
        await recordDialogState(windowId, 'location-submitted')
        return
      }
      await call('press_key', {
        pid,
        window_id: windowId,
        key: 'return',
        delivery_mode: 'foreground',
      })
      if (!(await recordDialogState(windowId, 'location-submitted'))) return
      const selected = await waitFor(async () => {
        if (!(await windows()).some(window => window.window_id === windowId)) return 'closed'
        const state = await snapshot(windowId)
        return state.elements.some(element =>
          `${element.label ?? ''} ${element.value ?? ''}`.includes(basename(path))
        )
      }, 'The native directory dialog did not navigate to the fixture directory')
      if (selected !== 'closed') await button(windowId, ACCEPT_LABEL)
    },
    async cancel(windowId) {
      if (platform === 'linux') {
        await dismissDialog(windowId, 'Escape')
        await recordDialogState(windowId, 'canceled')
        return
      }
      await button(windowId, CANCEL_LABEL)
    },
    async close() {
      await driver.shutdown()
      driver.uniffiDestroy?.()
    },
  }
}
