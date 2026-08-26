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

export async function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  return {
    async verify(control) {
      const initial = await waitForWindowState(
        control,
        state => state.visible && !state.minimized,
        'The Electron main window was not initially visible',
        uiTimeoutMs
      )

      if (initial.platform === 'darwin') {
        await control.command('waitFor', '[data-testid="macos-traffic-light-spacer"]', {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', '[data-testid="macos-titlebar-drag-region"]', {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command(
            'getComputedStyleValue',
            '[data-testid="macos-titlebar-drag-region"]',
            { value: '-webkit-app-region' }
          ),
          'drag',
          'The macOS titlebar drag region did not use Electron native dragging'
        )
        assert.equal(
          Number(await control.command('getElementCount', '[data-testid="window-frame-controls"]')),
          0,
          'macOS unexpectedly rendered custom frame controls over native traffic lights'
        )
      } else {
        await control.command('waitFor', '[data-testid="window-frame-controls"]', {
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          await control.command(
            'getComputedStyleValue',
            '[data-testid="window-frame-controls"]',
            { value: '-webkit-app-region' }
          ),
          'no-drag',
          'Window frame controls were not excluded from the Electron drag region'
        )

        await control.command('click', '[data-testid="window-minimize-button"]')
        await waitForWindowState(
          control,
          state => state.minimized,
          'Clicking the titlebar minimize button did not minimize the native window',
          uiTimeoutMs
        )
        await control.command('restoreMainWindow', 'body')
        await waitForWindowState(
          control,
          state => state.visible && !state.minimized,
          'The minimized native window did not restore',
          uiTimeoutMs
        )

        await control.command('click', '[data-testid="window-maximize-button"]')
        await waitForWindowState(
          control,
          state => state.maximized,
          'Clicking the titlebar maximize button did not maximize the native window',
          uiTimeoutMs
        )
        await control.command('click', '[data-testid="window-maximize-button"]')
        const restored = await waitForWindowState(
          control,
          state => !state.maximized,
          'Clicking the titlebar restore button did not restore the native window',
          uiTimeoutMs
        )
        assert.deepEqual(
          restored.bounds,
          restored.normalBounds,
          'The restored native window did not return to its normal bounds'
        )

        await control.command('click', '[data-testid="window-close-button"]')
        await control.command('waitFor', '[data-testid="runtime-task-close-confirm-overlay"]', {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', '[data-testid="runtime-task-close-cancel-button"]')
      }

      await captureScreenshot(control, 'native-window-chrome.png', 'body')
    },

    diagnostics() {
      return { nativeWindowChrome: true }
    },
  }
}
