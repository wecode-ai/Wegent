import assert from 'node:assert/strict'

const MENU_ITEM_IDS = [
  'application',
  'application.settings',
  'application.quit',
  'file',
  'file.newTaskTab',
  'file.newProjectSpaceTab',
  'file.closeTab',
  'work',
  'work.tasks',
  'work.projectSpaces',
  'work.plugins',
  'work.automations',
  'work.applications',
  'edit',
  'view',
  'view.search',
  'view.sidebar',
  'view.sidePanel',
  'view.terminal',
  'view.increaseFontSize',
  'view.decreaseFontSize',
  'view.resetFontSize',
  'window',
  'window.close',
  'window.showMain',
  'help',
  'help.project',
  'help.issues',
  'developer',
  'developer.devTools',
  'developer.commands',
  'developer.logs',
]

// Items gated on the active surface being a task workspace. Opening settings
// replaces the surface but keeps workspace tabs, so only these items must hide
// while settings is open; `file.closeTab` stays available because a closable
// tab still exists.
const TASK_SURFACE_GATED_IDS = ['view.search', 'view.sidebar', 'view.sidePanel', 'view.terminal']

function flatten(items) {
  return items.flatMap(item => [item, ...flatten(item.submenu ?? [])])
}

async function menuSnapshot(control) {
  return flatten(JSON.parse(await control.command('getApplicationMenuSnapshot', 'body')))
}

/**
 * Activates a menu item by id. The desktop control handler parses `value` as a
 * JSON payload, so the id must be wrapped in a JSON object rather than sent as
 * a bare string.
 */
async function activateMenuItem(control, id) {
  return JSON.parse(
    await control.command('activateApplicationMenu', 'body', {
      value: JSON.stringify({ id }),
    })
  )
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

async function waitForVisible(control, id, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = (await menuSnapshot(control)).find(item => item.id === id)
    if (latest?.visible === expected) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Expected ${id} visible=${expected}, received ${latest?.visible}`)
}

async function waitForElementCount(control, selector, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = -1
  while (Date.now() < deadline) {
    latest = Number(await control.command('getElementCount', selector))
    if (latest === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Expected ${selector} count=${expected}, received ${latest}`)
}

export async function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  return {
    async verify(control) {
      // Every declared item must exist so the menu structure cannot silently
      // lose an entry. Visibility is asserted separately below.
      const items = await menuSnapshot(control)
      for (const id of MENU_ITEM_IDS) {
        assert.ok(
          items.some(item => item.id === id),
          `${id} is missing from the application menu`
        )
      }
      assert.ok(
        items.some(item => item.role === 'copy'),
        'Native copy is missing from the application menu'
      )

      // A task surface must report its capabilities, which reveals the
      // task-only items instead of leaving them permanently hidden.
      await waitForVisible(control, 'view.terminal', true, uiTimeoutMs)
      await waitForVisible(control, 'view.search', true, uiTimeoutMs)

      // Search reuses the workbench search surface instead of a second path.
      assert.equal(await activateMenuItem(control, 'view.search'), true)
      await control.command('waitFor', '[data-testid="workbench-search-overlay"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workbench-search-close-button"]')
      await waitForElementCount(control, '[data-testid="workbench-search-overlay"]', 0, uiTimeoutMs)

      // Work-menu navigation opens real workspace surfaces.
      for (const [id, route] of [
        ['work.plugins', '/plugins'],
        ['work.automations', '/automations'],
        ['work.applications', '/sites'],
      ]) {
        assert.equal(await activateMenuItem(control, id), true, `${id} could not be activated`)
        await waitForRoute(control, route, uiTimeoutMs)
      }

      // Returning to the task workspace re-selects the existing tab instead of
      // opening a duplicate, and the workbench stays interactive afterwards.
      assert.equal(await activateMenuItem(control, 'work.tasks'), true)
      await waitForRoute(control, '/', uiTimeoutMs)
      await waitForVisible(control, 'view.terminal', true, uiTimeoutMs)

      // New tab items open workspace tabs without discarding the active one.
      assert.equal(await activateMenuItem(control, 'file.newTaskTab'), true)
      await waitForVisible(control, 'file.closeTab', true, uiTimeoutMs)
      await control.command('waitFor', '[data-testid^="workspace-tab-select-"]', {
        timeoutMs: uiTimeoutMs,
      })

      // Settings replaces the workspace surface, so task-only items must hide
      // rather than remain clickable dead entries.
      assert.equal(await activateMenuItem(control, 'application.settings'), true)
      await waitForRoute(control, '/settings', uiTimeoutMs)
      await waitForVisible(control, 'view.terminal', false, uiTimeoutMs)

      // The developer command entry stays available regardless of surface.
      assert.equal(await activateMenuItem(control, 'developer.commands'), true)
      await control.command('waitFor', '[data-testid="developer-command-open-web-inspector"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('press', '[data-testid="developer-command-open-web-inspector"]', {
        key: 'Escape',
      })

      // Task-surface items hide while the workbench is replaced by settings, so no
      // dead action is presented to the user. `file.closeTab` stays visible
      // because it is gated on a closable tab, which still exists.
      const settingsItems = await menuSnapshot(control)
      for (const id of TASK_SURFACE_GATED_IDS) {
        const item = settingsItems.find(candidate => candidate.id === id)
        assert.equal(item?.visible, false, `${id} stayed visible while settings is open`)
      }
      assert.equal(
        settingsItems.find(candidate => candidate.id === 'file.closeTab')?.visible,
        true,
        'file.closeTab hid even though a closable tab exists'
      )

      await captureScreenshot(control, 'application-menu-settings.png', 'body')
    },

    diagnostics() {
      return { applicationMenu: true }
    },
  }
}
