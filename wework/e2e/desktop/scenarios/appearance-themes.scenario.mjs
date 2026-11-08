import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { selectWorkbenchTheme } from '../modules/appearance-theme.mjs'
import { waitForClosedStartupSplash } from '../modules/native-window-state.mjs'

// Independent acceptance inventory: ChatGPT 26.1029.70936 (24905), 29 names / 44 variants.
// Wework adds its original light/dark palette: 30 names / 46 variants in total.
// Keep this fixture independent of the application catalogue so omissions fail CI.
const BOTH = [
  ['wework', 'Wework'],
  ['absolutely', 'Absolutely'],
  ['catppuccin', 'Catppuccin'],
  ['codex', 'ChatGPT'],
  ['everforest', 'Everforest'],
  ['github', 'GitHub'],
  ['gruvbox', 'Gruvbox'],
  ['linear', 'Linear'],
  ['notion', 'Notion'],
  ['one', 'One'],
  ['raycast', 'Raycast'],
  ['rose-pine', 'Rose Pine'],
  ['solarized', 'Solarized'],
  ['vercel', 'Vercel'],
  ['vscode-plus', 'VS Code Plus'],
  ['xcode', 'Xcode'],
]
const DARK = [
  ['ayu', 'Ayu'],
  ['dracula', 'Dracula'],
  ['lobster', 'Lobster'],
  ['material', 'Material'],
  ['matrix', 'Matrix'],
  ['monokai', 'Monokai'],
  ['night-owl', 'Night Owl'],
  ['nord', 'Nord'],
  ['og', 'OG'],
  ['oscurange', 'Oscurange'],
  ['sentry', 'Sentry'],
  ['temple', 'Temple'],
  ['tokyo-night', 'Tokyo Night'],
]
const LIGHT = [['proof', 'Proof']]
const SETTINGS = [
  ['/settings', 'general-settings-page'],
  ['/settings/connections', 'connections-device-settings-page'],
  ['/settings/appearance', 'appearance-settings-page'],
  ['/settings/personal/context', 'context-settings-page'],
  ['/settings/personal/models', 'model-settings-page'],
  ['/settings/personal/proxy', 'proxy-settings-page'],
  ['/settings/personal/keyboard-shortcuts', 'keyboard-shortcuts-settings-page'],
  ['/settings/personal/quick-phrases', 'quick-phrases-settings-page'],
  ['/settings/personal/runtimes', 'runtime-settings-page'],
  ['/settings/about', 'about-settings-page'],
  ['/settings/appshots', 'appshots-settings-page'],
  ['/settings/computer-use', 'computer-use-settings-page'],
  ['/settings/plugins', 'plugin-settings-page'],
  ['/settings/browser', 'browser-settings-page'],
  ['/settings/execution-environments', 'execution-environments-settings-page'],
  ['/settings/harnesses', 'harness-settings-page'],
  ['/settings/hooks', 'hooks-settings-page'],
  ['/settings/archived-conversations', 'archived-conversations-settings-page'],
  ['/settings/git-hosting', 'git-hosting-settings-page'],
  ['/settings/worktrees', 'worktrees-settings-page'],
]
const WORKSPACES = [
  ['/plugins', 'plugins-workspace'],
  ['/plugins/manage', 'plugin-management-page-content'],
  ['/sites', 'sites-workspace'],
  ['/automations', 'create-automation-button'],
  ['/pending-interactions', 'runtime-interactions-page'],
]

async function css(control, selector, property) {
  return control.command('getComputedStyleValue', selector, { value: property })
}

async function assertTokyoNight(control) {
  await control.command('waitFor', 'html[data-theme="dark"][data-appearance-theme="tokyo-night"]')
  assert.equal(await css(control, 'html', '--color-bg-base'), '26 27 38')
  assert.equal(await css(control, 'html', '--color-text-primary'), '169 177 214')
  assert.equal(await css(control, 'html', '--color-focus'), '122 162 247')
  assert.equal(await css(control, 'body', 'background-color'), 'rgb(26, 27, 38)')
}

export function createDesktopScenario({
  captureScreenshot,
  restartDesktopApp,
  resultDir,
  uiTimeoutMs,
}) {
  const evidence = { reference: 'ChatGPT 26.1029.70936 (24905)', variants: [], surfaces: [] }
  return {
    async verify(control) {
      await waitForClosedStartupSplash(control)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('waitFor', '[data-testid="appearance-settings-page"]', {
        timeoutMs: uiTimeoutMs,
      })

      for (const mode of ['light', 'dark']) {
        assert.equal(
          await control.command('getValue', `[data-testid="appearance-theme-select-${mode}"]`),
          'wework',
          `Fresh ${mode} preferences must default to Wework`
        )
      }

      for (const [mode, required] of [
        ['light', [...BOTH, ...LIGHT]],
        ['dark', [...BOTH, ...DARK]],
      ]) {
        const select = `[data-testid="appearance-theme-select-${mode}"]`
        assert.ok(
          Number(await control.command('getElementCount', `${select} option`)) >= required.length,
          `The ${mode} menu omits themes from the installed ChatGPT catalogue`
        )
        await control.command('click', `[data-testid="appearance-mode-${mode}"]`)
        for (const [id, label] of required) {
          assert.equal(await control.command('getText', `${select} option[value="${id}"]`), label)
          await control.command('select', select, { value: id })
          await control.command(
            'waitFor',
            `html[data-theme="${mode}"][data-appearance-theme="${id}"]`
          )
          const background = await css(control, 'body', 'background-color')
          const foreground = await css(
            control,
            '[data-testid="appearance-settings-page"] h1',
            'color'
          )
          assert.notEqual(
            background,
            'rgba(0, 0, 0, 0)',
            `${label} ${mode} has no application background`
          )
          assert.notEqual(background, foreground, `${label} ${mode} hides its settings text`)
          assert.ok(
            await css(control, 'html', '--color-syntax-keyword'),
            `${label} misses syntax tokens`
          )
          assert.ok(
            await css(control, 'html', '--color-terminal-blue'),
            `${label} misses ANSI tokens`
          )
          if (id === 'wework') {
            assert.equal(background, mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(24, 24, 24)')
            assert.equal(await css(control, 'html', '--color-primary'), '37 99 235')
            assert.equal(
              await css(control, 'html', '--color-sidebar'),
              mode === 'light' ? '246 246 246 / 0.88' : '33 33 33 / 0.92'
            )
          }
          await captureScreenshot(control, `appearance-theme-${mode}-${id}.png`, 'body')
          evidence.variants.push({ mode, id, label, background, foreground })
        }
      }
      assert.equal(evidence.variants.length, 46)

      await control.command('click', '[data-testid="appearance-reset-button"]')
      await control.command('waitFor', 'html[data-appearance-theme="wework"]')
      for (const mode of ['light', 'dark']) {
        assert.equal(
          await control.command('getValue', `[data-testid="appearance-theme-select-${mode}"]`),
          'wework',
          `Reset must restore the original Wework ${mode} palette`
        )
      }
      assert.equal(
        await control.command('getValue', '[data-testid="appearance-accent-input"]'),
        '#2563eb'
      )
      await captureScreenshot(control, 'appearance-wework-reset.png', 'body')

      // Independent light/dark choices must survive both renderer and native restarts.
      await selectWorkbenchTheme(control, {
        mode: 'light',
        themeId: 'proof',
        timeoutMs: uiTimeoutMs,
      })
      await selectWorkbenchTheme(control, { timeoutMs: uiTimeoutMs })
      await assertTokyoNight(control)
      const stored = JSON.parse(
        await control.command('getLocalStorageItem', 'body', {
          value: 'wework.appearance',
        })
      )
      assert.equal(stored.lightThemeId, 'proof')
      assert.equal(stored.darkThemeId, 'tokyo-night')
      await reloadMainWindow(control, 'Theme settings did not survive a renderer reload')
      await assertTokyoNight(control)
      assert.ok(restartDesktopApp, 'The appearance checkpoint requires a real Electron restart')
      await restartDesktopApp()
      await waitForClosedStartupSplash(control)
      await assertTokyoNight(control)

      // Exercise each actual desktop settings contribution, including plugin-injected pages.
      for (const [route, id] of SETTINGS) {
        await control.command('navigate', 'body', { value: route })
        await control.command('waitFor', `[data-testid="${id}"]`, { timeoutMs: uiTimeoutMs })
        await assertTokyoNight(control)
        assert.equal(await css(control, `[data-testid="${id}"] h1`, 'color'), 'rgb(169, 177, 214)')
        await captureScreenshot(control, `appearance-tokyo-${id}.png`, 'body')
        evidence.surfaces.push({ route, id })
      }

      for (const [route, id] of WORKSPACES) {
        await control.command('navigate', 'body', { value: route })
        await control.command('waitFor', `[data-testid="${id}"]`, { timeoutMs: uiTimeoutMs })
        await assertTokyoNight(control)
        await captureScreenshot(control, `appearance-tokyo-${id}.png`, 'body')
        evidence.surfaces.push({ route, id })
      }

      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', '[data-testid="desktop-workbench-main"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'appearance-tokyo-task-home.png', 'body')
      await control.command('clickWhenEnabled', '[data-testid="settings-button"]')
      await control.command('waitFor', '[data-testid="settings-menu-button"]')
      await captureScreenshot(control, 'appearance-tokyo-settings-popover.png', 'body')
      await control.command('press', 'body', { key: 'Escape' })
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('waitFor', '[data-testid="appearance-settings-page"]')
      await control.command('click', '[data-testid="appearance-mode-light"]')
      await control.command('waitFor', 'html[data-theme="light"][data-appearance-theme="proof"]')
      await captureScreenshot(control, 'appearance-proof-restored.png', 'body')
      await control.command('click', '[data-testid="appearance-mode-dark"]')
      await assertTokyoNight(control)
      await writeFile(
        join(resultDir, 'appearance-theme-evidence.json'),
        JSON.stringify(evidence, null, 2)
      )
    },
    diagnostics() {
      return evidence
    },
  }
}
