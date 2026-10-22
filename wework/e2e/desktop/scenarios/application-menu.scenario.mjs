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
  'developer.processExplorer',
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

async function waitForProcessExplorerWindow(control, predicate, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = JSON.parse(await control.command('getProcessExplorerWindowSnapshot', 'body'))
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${description}; received ${JSON.stringify(latest)}`)
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

async function waitForProcessExplorerControl(control, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    try {
      return await control.commandForWindow('process-explorer', 'getRoute', 'body')
    } catch (error) {
      latest = error
      if (!String(error?.message).includes('No desktop control client')) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`The Process Explorer control client did not connect: ${latest?.message}`)
}

async function waitForWindowElementCount(explorerCommand, selector, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = -1
  while (Date.now() < deadline) {
    latest = Number(await explorerCommand('getElementCount', selector))
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

      // The standalone window must inherit the main window's language and
      // theme. Capture the current preferences so later checkpoints keep the
      // environment they started with.
      const initialPreferences = JSON.parse(
        await control.command('setAppPreferences', 'body', { value: '{}' })
      )
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ language: 'en', appearanceMode: 'dark' }),
      })
      let language = ''
      for (let attempt = 0; attempt < 40; attempt += 1) {
        language = await control.command('getAttribute', 'html', { value: 'lang' })
        if (language === 'en') break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(language, 'en', 'The main window did not switch to English')

      // The process explorer reads the same host preference for its standalone
      // appearance and language.
      await new Promise(resolve => setTimeout(resolve, 300))

      // The Process Explorer opens as its own window through the same menu. It
      // is read-only, so no row may expose a termination action.
      assert.equal(await activateMenuItem(control, 'developer.processExplorer'), true)
      const processExplorer = await waitForProcessExplorerWindow(
        control,
        value =>
          value.exists &&
          value.visible &&
          value.testIds.includes('process-explorer-window') &&
          value.testIds.includes(`process-explorer-row-${value.applicationPid}`) &&
          value.text.includes('Uptime'),
        'The Process Explorer window did not render the application process',
        uiTimeoutMs
      )
      assert.ok(
        new URL(processExplorer.url).pathname.endsWith('/process-explorer'),
        `The Process Explorer loaded the wrong route: ${processExplorer.url}`
      )
      assert.match(
        processExplorer.text,
        /Uptime/,
        'The Process Explorer did not inherit the English language preference'
      )
      assert.doesNotMatch(
        processExplorer.text,
        /运行时长/,
        'The Process Explorer stayed in the previous language'
      )
      assert.match(
        processExplorer.text,
        /CPU\s+\d+\.\d+%/,
        'The Process Explorer summary did not render a percentage'
      )
      assert.equal(
        processExplorer.windowLabel,
        'process-explorer',
        'The Process Explorer ran with the main window label'
      )
      assert.equal(
        processExplorer.testIds.some(testId =>
          /^process-explorer-(end|confirm|cancel)-/.test(testId)
        ),
        false,
        'The Process Explorer exposed a termination action'
      )
      if (process.platform !== 'darwin') {
        assert.equal(
          processExplorer.menuBarVisible,
          false,
          'The Process Explorer rendered an application menu bar'
        )
      }
      assert.ok(
        processExplorer.testIds.includes('process-explorer-refresh'),
        'The Process Explorer did not render its refresh action'
      )
      assert.equal(
        processExplorer.testIds.includes('process-explorer-copy-diagnostics'),
        false,
        'The Process Explorer exposed a copy/export action'
      )
      assert.match(
        processExplorer.text,
        /\b\d+[smhd]\b/,
        'The Process Explorer did not render process uptime'
      )
      assert.ok(
        processExplorer.layout.tableScrollWidth <= processExplorer.layout.tableClientWidth + 1,
        `The Process Explorer table overflows horizontally: ${processExplorer.layout.tableScrollWidth} > ${processExplorer.layout.tableClientWidth}`
      )

      // The host window declares 520px as its minimum width, so the table must
      // stay readable without horizontal scrolling at that size.
      await control.command('setProcessExplorerWindowSize', 'body', {
        value: JSON.stringify({ width: 520, height: 640 }),
      })
      const compact = await waitForProcessExplorerWindow(
        control,
        value => value.exists && value.windowWidth === 520,
        'The Process Explorer did not resize to its minimum width',
        uiTimeoutMs
      )
      assert.ok(
        compact.layout.tableScrollWidth <= compact.layout.tableClientWidth + 1,
        `The Process Explorer table overflows at its minimum width: ${compact.layout.tableScrollWidth} > ${compact.layout.tableClientWidth}`
      )

      assert.equal(
        await waitForProcessExplorerControl(control, uiTimeoutMs),
        '/process-explorer',
        'The Process Explorer control client connected to the wrong route'
      )
      const explorerCommand = (action, selector, options) =>
        control.commandForWindow('process-explorer', action, selector, options)

      assert.equal(
        await explorerCommand('getAttribute', 'html', { value: 'data-theme' }),
        'dark',
        'The Process Explorer did not inherit the dark theme'
      )

      // Header edges resize a column, and the change is visible immediately.
      const firstColumnBefore = await explorerCommand(
        'getComputedStyleValue',
        '[data-testid="process-explorer-header-0"]',
        { value: 'width' }
      )
      await explorerCommand('dragBy', '[data-testid="process-explorer-resize-0"]', {
        value: JSON.stringify({ x: 48, y: 0 }),
      })
      const firstColumnAfterDrag = await explorerCommand(
        'getComputedStyleValue',
        '[data-testid="process-explorer-header-0"]',
        { value: 'width' }
      )
      assert.notEqual(
        firstColumnAfterDrag,
        firstColumnBefore,
        'The Process Explorer column did not resize from a pointer drag'
      )
      await explorerCommand('press', '[data-testid="process-explorer-resize-0"]', {
        key: 'ArrowLeft',
      })
      const firstColumnAfterKey = await explorerCommand(
        'getComputedStyleValue',
        '[data-testid="process-explorer-header-0"]',
        { value: 'width' }
      )
      assert.notEqual(
        firstColumnAfterKey,
        firstColumnAfterDrag,
        'The Process Explorer column did not resize from the keyboard'
      )

      const helperPids = []
      const groupStart = compact.testIds.indexOf('process-explorer-group-helpers')
      assert.notEqual(groupStart, -1, 'The Process Explorer did not render Chromium helpers')
      for (let index = groupStart + 1; index < compact.testIds.length; index += 1) {
        const testId = compact.testIds[index]
        if (testId.startsWith('process-explorer-group-')) break
        const match = /^process-explorer-row-(\d+)$/.exec(testId)
        if (match) helperPids.push(Number(match[1]))
      }
      assert.ok(helperPids.length > 0, 'The Process Explorer did not render Chromium helpers')
      const helperPid = helperPids[0]

      // The pin toggles the host window's always-on-top state.
      await explorerCommand('click', '[data-testid="process-explorer-always-on-top"]')
      await waitForProcessExplorerWindow(
        control,
        value => value.alwaysOnTop === true,
        'The Process Explorer did not stay on top',
        uiTimeoutMs
      )
      await explorerCommand('click', '[data-testid="process-explorer-always-on-top"]')
      await waitForProcessExplorerWindow(
        control,
        value => value.alwaysOnTop === false,
        'The Process Explorer did not stop staying on top',
        uiTimeoutMs
      )

      // Keyboard activation uses the same selection path as a pointer click.
      await explorerCommand('press', `[data-testid="process-explorer-row-${helperPid}"]`, {
        key: 'Enter',
      })
      await waitForWindowElementCount(explorerCommand, 'tr[aria-current="true"]', 1, uiTimeoutMs)

      // Collapsing an owner hides its rows and expanding it restores them.
      await explorerCommand('click', '[data-testid="process-explorer-toggle-helpers"]')
      await waitForWindowElementCount(
        explorerCommand,
        `[data-testid="process-explorer-row-${helperPid}"]`,
        0,
        uiTimeoutMs
      )
      await explorerCommand('click', '[data-testid="process-explorer-toggle-helpers"]')
      await explorerCommand('waitFor', `[data-testid="process-explorer-row-${helperPid}"]`, {
        timeoutMs: uiTimeoutMs,
      })

      // Search also matches launch arguments, so a PID need not identify a unique row.
      const helperName = await explorerCommand(
        'getText',
        `[data-testid="process-explorer-row-${helperPid}"] td:first-child`
      )
      assert.ok(helperName.trim(), 'The Chromium helper has no searchable process name')
      await explorerCommand('fill', '[data-testid="process-explorer-filter"]', {
        value: helperName.trim(),
      })
      await waitForWindowElementCount(
        explorerCommand,
        `[data-testid="process-explorer-row-${helperPid}"]`,
        1,
        uiTimeoutMs
      )
      await waitForWindowElementCount(
        explorerCommand,
        `[data-testid="process-explorer-row-${processExplorer.applicationPid}"]`,
        0,
        uiTimeoutMs
      )
      await explorerCommand('fill', '[data-testid="process-explorer-filter"]', { value: '' })
      await explorerCommand('waitFor', `[data-testid="process-explorer-row-${helperPid}"]`, {
        timeoutMs: uiTimeoutMs,
      })

      // The selected process detail remains readable in the footer.
      const selectionDetail = await explorerCommand(
        'getText',
        '[data-testid="process-explorer-selection-detail"]'
      )
      assert.ok(selectionDetail.length > 0, 'The Process Explorer hid the selected launch detail')
      assert.equal(
        selectionDetail.includes('\\??\\'),
        false,
        'The Process Explorer displayed the Windows object-manager prefix'
      )

      // The small icon copies only the selected launch detail.
      await explorerCommand('click', '[data-testid="process-explorer-copy-launch-details"]')
      let copied = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const label = await explorerCommand(
          'getAttribute',
          '[data-testid="process-explorer-copy-launch-details"]',
          { value: 'aria-label' }
        )
        if (/copied|已复制/i.test(label)) {
          copied = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(copied, true, 'The Process Explorer did not confirm the detail copy')
      const copiedDetail = await control.command('getClipboardText', 'body')
      assert.ok(copiedDetail.length > 0, 'The Process Explorer copied an empty detail')
      assert.equal(
        copiedDetail.includes('\\??\\'),
        false,
        'The Process Explorer copied the Windows object-manager prefix'
      )

      // A preference change made while the window is open must reach it without
      // reopening the standalone surface.
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ language: 'zh-CN', appearanceMode: 'light' }),
      })
      await waitForProcessExplorerWindow(
        control,
        value => value.exists && value.text.includes('运行时长'),
        'The open Process Explorer did not follow the language change',
        uiTimeoutMs
      )
      let liveTheme = ''
      for (let attempt = 0; attempt < 20; attempt += 1) {
        liveTheme = await explorerCommand('getAttribute', 'html', { value: 'data-theme' })
        if (liveTheme === 'light') break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(liveTheme, 'light', 'The open Process Explorer did not follow the theme change')

      const closeShortcut = process.platform === 'darwin' ? 'Meta+W' : 'Control+W'
      void explorerCommand('press', '[data-testid="process-explorer-window"]', {
        key: closeShortcut,
      }).catch(() => undefined)
      await waitForProcessExplorerWindow(
        control,
        value => !value.exists,
        'The Process Explorer did not close',
        uiTimeoutMs
      )
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({
          language: initialPreferences.language,
          appearanceMode: initialPreferences.appearanceMode,
        }),
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
