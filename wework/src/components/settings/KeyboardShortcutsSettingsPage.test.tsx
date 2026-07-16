import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: () => false,
}))

import { KeyboardShortcutsSettingsPage } from './KeyboardShortcutsSettingsPage'

describe('KeyboardShortcutsSettingsPage', () => {
  test('shows the configurable model selector shortcut', () => {
    render(<KeyboardShortcutsSettingsPage />)

    const row = screen.getByTestId('keyboard-shortcut-row-toggleModelSelector')
    expect(row).toHaveTextContent('选择模型')
    expect(row).toHaveTextContent('打开或关闭当前输入区的模型选择器')
    expect(row).toHaveTextContent('⌃ ⇧ M')
  })

  test('shows Codex-style font size shortcuts', () => {
    render(<KeyboardShortcutsSettingsPage />)

    expect(screen.getByTestId('keyboard-shortcut-row-increaseFontSize')).toHaveTextContent(
      '增大字号'
    )
    expect(screen.getByTestId('keyboard-shortcut-row-increaseFontSize')).toHaveTextContent('⌘ +')
    expect(screen.getByTestId('keyboard-shortcut-row-decreaseFontSize')).toHaveTextContent('⌘ −')
  })
})
