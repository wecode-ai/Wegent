import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const sourceRoot = resolve(process.cwd(), 'src')

const guardedFiles = [
  'components/layout/DesktopSidebar.tsx',
  'components/layout/DesktopSettingsMenu.tsx',
  'components/layout/EnvironmentInfoPopover.tsx',
  'components/layout/MobileDrawer.tsx',
  'components/chat/MessageList.tsx',
  'components/chat/ScrollableMessageArea.tsx',
  'components/chat/blocks/ToolBlockItem.tsx',
  'components/chat/blocks/ToolBlocksDisplay.tsx',
  'components/plugins/PluginCreateMenu.tsx',
  'components/plugins/PluginsWorkspace.tsx',
  'pages/PluginManagementPage.tsx',
  'pages/PluginsPage.tsx',
]

const forbiddenThemeClasses = [
  /\b(?:bg|text|border|ring|from|via|to)-\[#/g,
  /\b(?:bg|text|border)-(?:white|black)(?!\/)/g,
  /\bsurface-elevated\b/g,
]

describe('theme token guard', () => {
  test.each(guardedFiles)('%s uses theme tokens instead of hardcoded surface colors', relativePath => {
    const filePath = resolve(sourceRoot, relativePath)
    const source = readFileSync(filePath, 'utf8')

    const violations = forbiddenThemeClasses.flatMap(pattern =>
      [...source.matchAll(pattern)].map(match => match[0]),
    )

    expect(violations).toEqual([])
  })
})
