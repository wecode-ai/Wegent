import assert from 'node:assert/strict'

async function readWindowState(control) {
  return JSON.parse(await control.command('getNativeWindowState', 'body'))
}

async function readBackgroundPolicy(control) {
  return JSON.parse(await control.command('getWindowBackgroundPolicy', 'body'))
}

async function readDocumentVisibility(control) {
  return control.command('getDocumentVisibility', 'body')
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

async function waitForDocumentVisibility(control, expected, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await readDocumentVisibility(control)
    if (latest === expected) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${latest}`)
}

/**
 * Windows only restores precision-touchpad input when the native window keeps
 * Chromium's default visibility lifecycle. Disabling throttling per window
 * (webPreferences.backgroundThrottling) leaves the renderer input HWND hidden
 * after an occlusion or minimize, and the following gesture arrives as
 * mouse-wheel deltas, which scrolls several times faster. This checkpoint
 * guards that policy and the visible/minimized/restored cycle that triggered
 * the defect.
 */
export async function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  return {
    async verify(control) {
      const policy = await readBackgroundPolicy(control)
      const isWindows = policy.platform === 'win32'
      assert.equal(
        policy.backgroundThrottling,
        isWindows,
        isWindows
          ? 'Windows must keep the default background visibility lifecycle so touchpad input survives occlusion'
          : 'Non-Windows platforms keep per-window background throttling disabled'
      )
      if (isWindows) {
        assert.equal(
          policy.backgroundTimerThrottlingDisabled,
          true,
          'Windows must keep background timers running through Chromium timer throttling policy'
        )
      }

      await waitForWindowState(
        control,
        state => state.visible && !state.minimized,
        'The Electron main window was not initially visible',
        uiTimeoutMs
      )
      await waitForDocumentVisibility(
        control,
        'visible',
        'The workbench renderer was not visible before the native window cycle',
        uiTimeoutMs
      )

      if (policy.platform !== 'darwin') {
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
        await waitForDocumentVisibility(
          control,
          'visible',
          'The workbench renderer did not become visible again after restore',
          uiTimeoutMs
        )
        await control.command('getRoute', 'body')
      }

      await captureScreenshot(control, 'window-background-policy.png', 'body')
    },

    diagnostics() {
      return { windowBackgroundPolicy: true }
    },
  }
}
