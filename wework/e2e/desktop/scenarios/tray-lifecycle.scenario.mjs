import assert from 'node:assert/strict'

async function readWindowState(control) {
  return JSON.parse(await control.command('getNativeWindowState', 'body'))
}

async function waitForReadyAfter(control, readyCount, timeoutMs, message) {
  let timeout
  const reconnectTimeout = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    await Promise.race([control.awaitReadyAfter(readyCount), reconnectTimeout])
  } finally {
    clearTimeout(timeout)
  }
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
  let launchSecondInstance = null

  return {
    appEnvironment: {
      WEWORK_E2E_BACKGROUND_WINDOW: '0',
    },

    setLaunchSecondInstance(launch) {
      launchSecondInstance = launch
    },

    async verify(control) {
      assert.ok(launchSecondInstance, 'The second-instance launcher was not configured')
      const tray = JSON.parse(await control.command('getTraySnapshot', 'body'))
      assert.equal(tray.created, true, 'The Electron Tray was not created')
      assert.match(
        tray.guid,
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        'The Electron Tray did not expose a persistent application GUID'
      )
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

      const readyCountBeforeSecondInstance = control.readyCount
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

      await launchSecondInstance()
      await waitForReadyAfter(
        control,
        readyCountBeforeSecondInstance,
        uiTimeoutMs,
        'Launching Wework again did not reconnect the desktop controller'
      )
      const secondInstanceRestored = await waitForWindowState(
        control,
        state => state.visible && !state.minimized,
        'Launching Wework again did not restore the hidden main window',
        uiTimeoutMs
      )
      if (secondInstanceRestored.platform === 'darwin') {
        assert.equal(
          secondInstanceRestored.dockVisible,
          true,
          'Launching Wework again did not restore the macOS Dock icon'
        )
      }
      await captureScreenshot(control, 'tray-lifecycle-second-instance-restored.png', 'body')

      const readyCountBeforeTrayRestore = control.readyCount
      await control.command('requestMainWindowClose', 'body')
      await waitForWindowState(
        control,
        state => !state.visible,
        'A subsequent close-to-tray request did not hide the Electron window',
        uiTimeoutMs
      )
      await control.command('activateTray', 'body', {
        value: JSON.stringify({ type: 'click' }),
      })
      await waitForReadyAfter(
        control,
        readyCountBeforeTrayRestore,
        uiTimeoutMs,
        'Restoring the main window from Tray did not reconnect the desktop controller'
      )
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
      return { secondInstanceRestore: true, trayLifecycle: true }
    },
  }
}
