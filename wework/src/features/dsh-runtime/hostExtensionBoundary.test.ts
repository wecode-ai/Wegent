import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const hostFiles = [
  'src/components/chat/composer/PopoutWorkspaceMenu.tsx',
  'src/components/chat/composer/ProjectWorkBar.tsx',
  'src/components/settings/MobileSettingsPage.tsx',
  'src/components/settings/RuntimeSettingsPage.tsx',
  'src/features/dsh-runtime/dshUiSlots.ts',
  'src/features/dsh-runtime/useDshSlotAvailable.ts',
]

const implementationTerms = /\b(?:git|branch|worktree|source.?control)\b/i

describe('DSH host extension boundary', () => {
  test.each(hostFiles)('%s contains only positional extension contracts', file => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    expect(source).not.toMatch(implementationTerms)
  })

  test('the implementation plugin owns repository-specific workspace controls', () => {
    const pluginSource = readFileSync(
      resolve(process.cwd(), 'dsh/ui-git/src/project-work-section.tsx'),
      'utf8'
    )
    expect(pluginSource).toMatch(/\bgit(?:\b|_)/i)
    expect(pluginSource).toMatch(/\bbranch\b/i)
    expect(pluginSource).toMatch(/\bworktree\b/i)
  })
})
