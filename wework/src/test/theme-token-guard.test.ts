import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'postcss'
import { describe, expect, test } from 'vitest'

const sourceRoot = resolve(process.cwd(), 'src')

const guardedFiles = [
  'components/chat/AssistantMarkdown.tsx',
  '../../packages/collaboration/src/conversation/CodexTurnArtifacts.tsx',
  'components/chat/composer/CompactChatComposer.tsx',
  'components/chat/composer/ComposerToolbar.tsx',
  '../../packages/collaboration/src/composer/ComposerProseMirrorEditor.tsx',
  '../../packages/collaboration/src/composer/LinkEditPopover.tsx',
  'components/chat/composer/ContextUsageIndicator.tsx',
  '../../packages/collaboration/src/controls/ModelAutomaticReasoningOption.tsx',
  '../../packages/collaboration/src/controls/ModelSelector.tsx',
  '../../packages/collaboration/src/controls/ActionMenu.tsx',
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
  '../../packages/collaboration/src/conversation/MessageList.tsx',
  '../../packages/collaboration/src/conversation/UserMessage.tsx',
  '../../packages/collaboration/src/conversation/UserMessageEditForm.tsx',
  '../../packages/collaboration/src/conversation/AssistantMessage.tsx',
  '../../packages/collaboration/src/conversation/AssistantErrorCard.tsx',
  '../../packages/collaboration/src/conversation/GeneratedImageGallery.tsx',
  '../../packages/collaboration/src/conversation/MessageHoverActions.tsx',
  '../../packages/collaboration/src/conversation/CodeCommentPreview.tsx',
  '../../packages/collaboration/src/conversation/ImSourceBadge.tsx',
  '../../packages/collaboration/src/conversation/FileChangesCard.tsx',
  '../../packages/collaboration/src/conversation/ScrollableMessageArea.tsx',
  '../../packages/collaboration/src/conversation/RuntimeTranscriptGapMarker.tsx',
  '../../packages/collaboration/src/conversation/blocks/ToolBlockItem.tsx',
  '../../packages/collaboration/src/conversation/blocks/ToolBlocksDisplay.tsx',
  '../../packages/collaboration/src/conversation/blocks/ToolFileChanges.tsx',
  '../../packages/collaboration/src/conversation/blocks/ToolInlineDiff.tsx',
  '../../packages/collaboration/src/conversation/blocks/ToolBlockDetails.tsx',
  '../../packages/collaboration/src/conversation/blocks/toolBlockLabels.tsx',
  '../../packages/collaboration/src/conversation/blocks/ProcessingActivity.tsx',
  '../../packages/collaboration/src/conversation/blocks/ProcessingPreview.tsx',
  '../../packages/collaboration/src/conversation/FileChangesPreview.tsx',
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
  '../../packages/collaboration/src/controls/ModelSelector.tsx',
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
  test('uses the ChatGPT Electron default UI weight without changing medium emphasis', () => {
    const globalsPath = resolve(process.cwd(), 'src/styles/globals.css')
    const source = readFileSync(globalsPath, 'utf8')

    expect(source).toContain('--font-weight-ui: 445;')
    expect(source).toContain('font-weight: var(--font-weight-ui);')
    expect(source).toContain('font-weight: 500;')
  })

  test('styles do not reference the removed background token alias', () => {
    const guardedStylePaths = [
      resolve(process.cwd(), 'src/styles/globals.css'),
      resolve(process.cwd(), '../packages/collaboration/src/issue-detail/task-detail-layout.css'),
      resolve(process.cwd(), '../packages/collaboration/src/conversation/file-change-motion.css'),
      resolve(process.cwd(), '../packages/collaboration/src/composer/styles.css'),
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

  test('native select menus derive their popup colors from theme tokens', () => {
    const globalsPath = resolve(process.cwd(), 'src/styles/globals.css')
    const source = readFileSync(globalsPath, 'utf8')

    expect(source).toContain('.wework-native-select optgroup {')
    expect(source).toContain('.wework-native-select option {')
    expect(source).toContain('.wework-native-select option:disabled {')
    expect(source).toContain('background-color: rgb(var(--color-popover));')
    expect(source).toContain('color: rgb(var(--color-text-primary));')
    expect(source).toContain('color: rgb(var(--color-text-secondary));')
    expect(source).toContain('color: rgb(var(--color-text-muted));')
  })

  test('titlebar and window frame use the same opaque surface colors', () => {
    const globalsPath = resolve(process.cwd(), 'src/styles/globals.css')
    const source = readFileSync(globalsPath, 'utf8')

    expect(source.match(/--color-bg-surface: 247 247 248;/g)).toHaveLength(1)
    expect(source.match(/--color-titlebar: 247 247 248;/g)).toHaveLength(1)
    expect(source.match(/--color-bg-surface: 33 33 33;/g)).toHaveLength(1)
    expect(source.match(/--color-titlebar: 33 33 33;/g)).toHaveLength(1)
  })

  test('tailwind exposes semantic z-index layers', () => {
    const tailwindConfigPath = resolve(
      process.cwd(),
      '../packages/collaboration/tailwind-preset.js'
    )
    const source = readFileSync(tailwindConfigPath, 'utf8')

    expect(source).toContain("chrome: 'var(--z-chrome)'")
    expect(source).toContain("popover: 'var(--z-popover)'")
    expect(source).toContain("modal: 'var(--z-modal)'")
    expect(source).toContain("critical: 'var(--z-critical)'")
    expect(source).toContain("system: 'var(--z-system)'")
  })

  test('native scrollbars share the quiet workbench colors without requiring a utility class', () => {
    const globalsPath = resolve(process.cwd(), 'src/styles/globals.css')
    const source = readFileSync(globalsPath, 'utf8').replace(/\r\n/g, '\n')

    expect(source).toContain('*,\n  .scrollbar-soft {')
    expect(source).toContain('scrollbar-color: rgb(var(--color-scrollbar-thumb)) transparent;')
    expect(source).not.toContain(
      'scrollbar-color: rgb(var(--color-scrollbar-thumb-hover)) transparent;'
    )
    expect(source).toContain('--color-scrollbar-thumb: 0 0 0 / 0.08;')
    expect(source).toContain('--color-scrollbar-thumb-hover: 0 0 0 / 0.12;')
    expect(source).not.toContain('--color-sidebar-scrollbar')
    expect(source).toContain('width: 8px;')
    expect(source).toContain('height: 8px;')
    expect(source).toContain('background-color: rgb(var(--color-scrollbar-thumb));')
    expect(source).toContain('background-color: rgb(var(--color-scrollbar-thumb-hover));')
    expect(source).toContain('::-webkit-scrollbar-track,')
    expect(source).toContain('background: transparent;')
    expect(source).toContain('::-webkit-scrollbar-track-piece,')
    expect(source).toContain('::-webkit-scrollbar-corner {')
    expect(source).toContain('border: 0;')
    expect(source).toContain('border-radius: 999px;')
  })

  test('WebKit scrollbar rules are not suppressed by standard scrollbar properties', () => {
    const styles = parse(readFileSync(resolve(sourceRoot, 'styles/globals.css'), 'utf8'))
    const overrides = new Map<string, Record<string, string>>()
    styles.walkAtRules('supports', support => {
      if (support.params !== 'selector(::-webkit-scrollbar)') return
      support.walkRules(rule => {
        const declarations: Record<string, string> = {}
        rule.walkDecls(declaration => {
          declarations[declaration.prop] = declaration.value
        })
        rule.selectors.forEach(selector => overrides.set(selector, declarations))
      })
    })

    for (const selector of ['*', '.scrollbar-soft']) {
      expect(overrides.get(selector)).toEqual({
        'scrollbar-color': 'auto',
        'scrollbar-width': 'auto',
      })
    }
    const hiddenWidths: string[] = []
    styles.walkRules('.scrollbar-none', rule => {
      rule.walkDecls('scrollbar-width', declaration => {
        hiddenWidths.push(declaration.value)
      })
    })
    expect(hiddenWidths).toEqual(['none'])
  })

  test('dark scrollbar thumbs remain distinguishable on the default app surfaces', () => {
    const source = readFileSync(resolve(sourceRoot, 'styles/globals.css'), 'utf8')
    const tokens = new Map<string, string>()
    parse(source).walkRules("[data-theme='dark']", rule => {
      rule.walkDecls(declaration => {
        tokens.set(declaration.prop, declaration.value)
      })
    })
    const luminance = (rgb: number[]) =>
      rgb.reduce((sum, value, index) => {
        const channel = value / 255
        const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        return sum + linear * [0.2126, 0.7152, 0.0722][index]
      }, 0)

    for (const surface of ['--color-bg-base', '--color-bg-surface', '--color-popover']) {
      const background = tokens.get(surface)!.split(/\s+/).map(Number)
      for (const thumb of ['--color-scrollbar-thumb', '--color-scrollbar-thumb-hover']) {
        const [color, opacity] = tokens.get(thumb)!.split('/')
        const alpha = Number(opacity)
        const foreground = color
          .trim()
          .split(/\s+/)
          .map((value, index) => Number(value) * alpha + background[index] * (1 - alpha))
        const contrast = (luminance(foreground) + 0.05) / (luminance(background) + 0.05)
        expect(contrast, `${thumb} on ${surface}`).toBeGreaterThanOrEqual(3)
      }
    }
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
