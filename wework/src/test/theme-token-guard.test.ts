import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const sourceRoot = resolve(process.cwd(), 'src')

const guardedFiles = [
  'components/chat/AssistantMarkdown.tsx',
  'components/chat/CodexTurnArtifacts.tsx',
  'components/chat/composer/CompactChatComposer.tsx',
  'components/chat/composer/ComposerToolbar.tsx',
  'components/chat/composer/ContextUsageIndicator.tsx',
  'components/chat/composer/ModelAutomaticReasoningOption.tsx',
  'components/chat/composer/ModelSelector.tsx',
  'components/common/ActionMenu.tsx',
  'components/layout/DesktopAppSwitcher.tsx',
  'components/layout/workspace-panels/FileWorkspacePanel.tsx',
  'components/projects/DeviceFolderPicker.tsx',
  'components/projects/ProjectCreateDialog.tsx',
  'features/todo/TodoCreateDialog.tsx',
  'features/todo/TodoDetailPanel.tsx',
  'features/todo/TodoWorkItems.tsx',
  'components/layout/DesktopSidebar.tsx',
  'components/layout/DesktopSettingsMenu.tsx',
  'components/layout/EnvironmentInfoPopover.tsx',
  'components/chat/MessageList.tsx',
  'components/chat/FileChangesCard.tsx',
  'components/chat/ScrollableMessageArea.tsx',
  'components/chat/blocks/ToolBlockItem.tsx',
  'components/chat/blocks/ToolBlocksDisplay.tsx',
  'components/plugins/PluginCreateMenu.tsx',
  'components/plugins/PluginsWorkspace.tsx',
  '../dsh/ui-plugin-center/src/PluginManagementPage.tsx',
  '../dsh/ui-plugin-center/src/PluginsPage.tsx',
]

const forbiddenThemeClasses = [
  /\b(?:bg|text|border|ring|from|via|to)-\[#/g,
  /\b(?:bg|text|border)-(?:white|black)(?!\/)/g,
  /\bsurface-elevated\b/g,
]

const zIndexGuardedFiles = [
  'components/chat/composer/CompactChatComposer.tsx',
  'components/chat/composer/ModelSelector.tsx',
  'components/chat/composer/ProjectChatComposer.tsx',
  'components/chat/composer/ComposerTextarea.tsx',
  'components/layout/DesktopWorkbenchLayout.tsx',
  'components/layout/DesktopWorkbenchMain.tsx',
  'components/layout/MobileDrawer.tsx',
  'components/layout/MobileWorkbenchLayout.tsx',
  '../dsh/ui-plugin-center/src/PluginManagementPage.tsx',
  '../dsh/ui-plugin-center/src/PluginsPage.tsx',
]

const forbiddenGlobalZIndexClasses = [
  /\bz-(?:50|60|70|80|90)\b/g,
  /\bz-\[(?:[5-9]\d|[1-9]\d{2,})\]/g,
]

describe('theme token guard', () => {
  test('styles do not reference the removed background token alias', () => {
    const guardedStylePaths = [
      resolve(process.cwd(), 'src/styles/globals.css'),
      resolve(sourceRoot, 'features/todo/task-detail-layout.css'),
    ]

    for (const stylePath of guardedStylePaths) {
      expect(readFileSync(stylePath, 'utf8')).not.toContain('--color-background')
    }
  })

  test('tailwind exposes semantic surface colors', () => {
    const tailwindConfigPath = resolve(process.cwd(), 'tailwind.config.js')
    const source = readFileSync(tailwindConfigPath, 'utf8').replace(/\r\n/g, '\n')
    const colorsBlock = source.slice(source.indexOf('colors: {'), source.indexOf('borderRadius:'))

    expect(source).toContain(
      "backgroundColor: {\n        base: 'rgb(var(--color-bg-base) / <alpha-value>)'"
    )
    expect(colorsBlock).not.toContain("base: 'rgb(var(--color-bg-base) / <alpha-value>)'")
    expect(source).toContain("background: 'rgb(var(--color-bg-base) / <alpha-value>)'")
    expect(source).toContain("surface: 'rgb(var(--color-bg-surface) / <alpha-value>)'")
    expect(source).toContain("popover: 'rgb(var(--color-popover) / <alpha-value>)'")
  })

  test('tailwind dark variants follow the application theme class', () => {
    const tailwindConfigPath = resolve(process.cwd(), 'tailwind.config.js')
    const source = readFileSync(tailwindConfigPath, 'utf8')

    expect(source).toContain("darkMode: 'class'")
  })

  test('titlebar and window frame use the same opaque surface colors', () => {
    const globalsPath = resolve(process.cwd(), 'src/styles/globals.css')
    const source = readFileSync(globalsPath, 'utf8')

    expect(source.match(/--color-bg-surface: 247 247 248;/g)).toHaveLength(1)
    expect(source.match(/--color-titlebar: 247 247 248;/g)).toHaveLength(1)
    expect(source.match(/--color-bg-surface: 28 31 36;/g)).toHaveLength(1)
    expect(source.match(/--color-titlebar: 28 31 36;/g)).toHaveLength(1)
  })

  test('tailwind exposes semantic z-index layers', () => {
    const tailwindConfigPath = resolve(process.cwd(), 'tailwind.config.js')
    const source = readFileSync(tailwindConfigPath, 'utf8')

    expect(source).toContain("chrome: 'var(--z-chrome)'")
    expect(source).toContain("popover: 'var(--z-popover)'")
    expect(source).toContain("modal: 'var(--z-modal)'")
    expect(source).toContain("critical: 'var(--z-critical)'")
    expect(source).toContain("system: 'var(--z-system)'")
  })

  test('soft scrollbar uses a visible light gray thumb before hover', () => {
    const globalsPath = resolve(process.cwd(), 'src/styles/globals.css')
    const source = readFileSync(globalsPath, 'utf8')

    expect(source).toContain('scrollbar-color: rgb(170 170 170 / 0.85) transparent;')
    expect(source).toContain('width: 7px;')
    expect(source).toContain('height: 7px;')
    expect(source).toContain('background-color: rgb(170 170 170 / 0.85);')
    expect(source).toContain('.scrollbar-soft::-webkit-scrollbar-track {')
    expect(source).toContain('background: transparent;')
    expect(source).toContain('.scrollbar-soft::-webkit-scrollbar-track-piece {')
    expect(source).toContain('.scrollbar-soft::-webkit-scrollbar-corner {')
    expect(source).toContain('border: 1px solid transparent;')
    expect(source).toContain('border-radius: 999px;')
  })

  test('browser annotation toolbar surface derives from theme tokens for dark mode', () => {
    const globalsPath = resolve(process.cwd(), 'src/styles/globals.css')
    const globalsSource = readFileSync(globalsPath, 'utf8')
    const panelPath = resolve(
      sourceRoot,
      'components/layout/workspace-panels/WorkspaceBrowserPanel.tsx'
    )
    const panelSource = readFileSync(panelPath, 'utf8')

    expect(globalsSource).toContain('--color-browser-annotation-surface: color-mix(')
    expect(globalsSource).toContain('rgb(var(--color-bg-surface)) 82%')
    expect(globalsSource).toContain('rgb(var(--color-focus)) 18%')
    expect(panelSource).not.toMatch(/\b(?:bg|border|text)-blue-(?:50|100|200|700)\b/)
    expect(panelSource).toContain('bg-[var(--color-browser-annotation-surface)]')
    expect(panelSource).toContain('border-[var(--color-browser-annotation-border)]')
    expect(panelSource).toContain('bg-[var(--color-browser-annotation-chip)]')
  })

  test.each(guardedFiles)(
    '%s uses theme tokens instead of hardcoded surface colors',
    relativePath => {
      const filePath = resolve(sourceRoot, relativePath)
      const source = readFileSync(filePath, 'utf8')

      const violations = forbiddenThemeClasses.flatMap(pattern =>
        [...source.matchAll(pattern)].map(match => match[0])
      )

      expect(violations).toEqual([])
    }
  )

  test.each(zIndexGuardedFiles)(
    '%s uses semantic z-index layers for global stacking',
    relativePath => {
      const filePath = resolve(sourceRoot, relativePath)
      const source = readFileSync(filePath, 'utf8')

      const violations = forbiddenGlobalZIndexClasses.flatMap(pattern =>
        [...source.matchAll(pattern)].map(match => match[0])
      )

      expect(violations).toEqual([])
    }
  )
})
