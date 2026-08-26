import assert from 'node:assert/strict'

async function readWindowState(control) {
  return JSON.parse(await control.command('getNativeWindowState', 'body'))
}

async function waitForWindowState(control, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await readWindowState(control)
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

async function waitForRoute(control, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = ''
  while (Date.now() < deadline) {
    latest = await control.command('getRoute', 'body')
    if (latest === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Expected route ${expected}, received ${latest}`)
}

export async function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  return {
    async verify(control) {
      const tray = JSON.parse(await control.command('getTraySnapshot', 'body'))
      assert.equal(tray.created, true, 'The Electron Tray was not created')
      assert.ok(
        tray.menu.some(item => item.id === 'settings'),
        'The Electron Tray did not expose Settings'
      )
      assert.ok(
        tray.menu.some(item => item.id === 'quit'),
        'The Electron Tray did not expose Quit'
      )

      assert.equal(
        JSON.parse(
          await control.command('activateTray', 'body', {
            value: JSON.stringify({ type: 'menu-item', menuItemId: 'settings' }),
          })
        ),
        true,
        'The Electron Tray Settings action was not activated'
      )
      await waitForRoute(control, '/settings', uiTimeoutMs)

      const readyCountBeforeClose = control.readyCount
      await control.command('requestMainWindowClose', 'body')
      await control.command('waitFor', '[data-testid="runtime-task-close-confirm-overlay"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="runtime-task-close-confirm-button"]')
      const hidden = await waitForWindowState(
        control,
        state => !state.visible,
        'Confirming close-to-tray did not hide the Electron window',
        uiTimeoutMs
      )
      if (hidden.platform === 'darwin') {
        assert.equal(hidden.dockVisible, false, 'Closing to Tray did not hide the macOS Dock icon')
      }

      await control.command('activateTray', 'body', {
        value: JSON.stringify({ type: 'click' }),
      })
      await control.awaitReadyAfter(readyCountBeforeClose)
      const restored = await waitForWindowState(
        control,
        state => state.visible && !state.minimized,
        'Clicking the Electron Tray did not restore the main window',
        uiTimeoutMs
      )
      if (restored.platform === 'darwin') {
        assert.equal(restored.dockVisible, true, 'Restoring from Tray did not show the Dock icon')
      }
      await captureScreenshot(control, 'tray-lifecycle-restored.png', 'body')
    },

    diagnostics() {
      return { trayLifecycle: true }
    },
  }
}
