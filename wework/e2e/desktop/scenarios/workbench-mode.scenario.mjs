import assert from 'node:assert/strict'

const WORKBENCH_READY_TIMEOUT_MS = 120_000

async function openGeneralSettings(control) {
  await control.command('navigate', 'body', { value: '/settings' })
  await control.command('waitFor', '[data-testid="general-settings-page"]')
}

async function switchMode(control, mode) {
  const readyCount = control.readyCount
  await control.command('clickWhenEnabled', `[data-testid="general-workbench-mode-${mode}-button"]`)
  await control.command('clickWhenEnabled', '[data-testid="general-workbench-mode-confirm-button"]')

  let timeout
  const reconnectTimeout = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Switching to ${mode} mode did not restart the plugin runtime`)),
      WORKBENCH_READY_TIMEOUT_MS
    )
  })
  try {
    await Promise.race([control.awaitReadyAfter(readyCount), reconnectTimeout])
  } finally {
    clearTimeout(timeout)
  }
}

async function assertMode(control, mode) {
  assert.equal(
    await control.command('getAttribute', `[data-testid="general-workbench-mode-${mode}-button"]`, {
      value: 'aria-pressed',
    }),
    'true',
    `Workbench mode did not persist as ${mode}`
  )
}

export async function createDesktopScenario() {
  return {
    async verify(control) {
      await openGeneralSettings(control)
      await assertMode(control, 'developer')
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="settings-nav-worktrees"]')),
        1,
        'Developer mode did not expose Git settings'
      )

      await switchMode(control, 'focus')
      await openGeneralSettings(control)
      await assertMode(control, 'focus')
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="settings-nav-worktrees"]')),
        0,
        'Focus mode still exposed Git settings'
      )
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="settings-nav-git-hosting"]')
        ),
        0,
        'Focus mode still exposed code-hosting settings'
      )

      await switchMode(control, 'developer')
      await openGeneralSettings(control)
      await assertMode(control, 'developer')
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="settings-nav-worktrees"]')),
        1,
        'Developer mode did not restore Git settings'
      )
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="settings-nav-git-hosting"]')
        ),
        1,
        'Developer mode did not restore code-hosting settings'
      )
    },

    diagnostics() {
      return { workbenchMode: true }
    },
  }
}
