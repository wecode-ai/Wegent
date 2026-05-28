// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import type { UnifiedShell } from '@/apis/shells'
import ExecutorModeSelector from '@/features/settings/components/team-edit/ExecutorModeSelector'
import enSettings from '@/i18n/locales/en/settings.json'
import zhSettings from '@/i18n/locales/zh-CN/settings.json'

const shells: UnifiedShell[] = [
  { name: 'Chat', type: 'public', displayName: 'Chat', shellType: 'Chat' },
  { name: 'ClaudeCode', type: 'public', displayName: 'Claude Code', shellType: 'ClaudeCode' },
  { name: 'team-shell', type: 'group', displayName: 'Team Shell', shellType: 'ClaudeCode' },
]

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings:team.simple.executor.title': 'Executor',
        'settings:team.simple.executor.simple.title': 'Simple',
        'settings:team.simple.executor.simple.description': 'Chat executor.',
        'settings:team.simple.executor.complex.title': 'Complex',
        'settings:team.simple.executor.complex.description':
          'Complex executor for code tasks, device tasks, or multi-step complex tasks.',
        'settings:team.simple.executor.custom.title': 'Custom',
        'settings:team.simple.executor.custom.description': 'Use an executor you created.',
        'settings:team.simple.executor.custom_shell_placeholder': 'Choose custom executor',
        'settings:team.simple.executor.no_custom_shells': 'No custom executors available',
        'settings:team.simple.executor.manage_custom_shells_hint':
          'Manage custom executors in Resource Library - Executors.',
      })[key] || key,
  }),
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode
    onValueChange?: (value: string) => void
  }) => (
    <div data-testid="custom-shell-select" onClick={() => onValueChange?.('team-shell')}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}))

describe('ExecutorModeSelector', () => {
  it('renders simple, complex, and custom executor cards', () => {
    render(
      <ExecutorModeSelector
        value="simple"
        onChange={jest.fn()}
        shells={shells}
        customShellName=""
        onCustomShellChange={jest.fn()}
      />
    )

    expect(screen.getByRole('radio', { name: /simple/i })).toBeChecked()
    expect(screen.getByRole('radio', { name: /complex/i })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /custom/i })).not.toBeChecked()
    expect(screen.getByText('Chat executor.')).toBeInTheDocument()
  })

  it('shows custom shell select when custom executor is selected', () => {
    const onCustomShellChange = jest.fn()

    render(
      <ExecutorModeSelector
        value="custom"
        onChange={jest.fn()}
        shells={shells}
        customShellName=""
        onCustomShellChange={onCustomShellChange}
      />
    )
    fireEvent.click(screen.getByTestId('custom-shell-select'))

    expect(screen.getByText('Team Shell')).toBeInTheDocument()
    expect(onCustomShellChange).toHaveBeenCalledWith('team-shell')
  })

  it('shows an empty-state option when no custom shells exist', () => {
    render(
      <ExecutorModeSelector
        value="custom"
        onChange={jest.fn()}
        shells={shells.filter(shell => shell.type === 'public')}
        customShellName=""
        onCustomShellChange={jest.fn()}
      />
    )

    expect(screen.getAllByText('No custom executors available')).toHaveLength(2)
    expect(
      screen.getByText('Manage custom executors in Resource Library - Executors.')
    ).toBeInTheDocument()
  })

  it('uses executor terminology in localized custom executor descriptions', () => {
    expect(zhSettings.team.simple.executor.custom.description).toBe(
      '使用你创建的执行器，适合特殊运行环境。'
    )
    expect(enSettings.team.simple.executor.custom.description).toBe(
      'Uses an executor you created for a specialized runtime.'
    )
  })

  it('selects custom executor when the custom card is clicked', () => {
    const onChange = jest.fn()

    render(
      <ExecutorModeSelector
        value="complex"
        onChange={onChange}
        shells={shells}
        customShellName=""
        onCustomShellChange={jest.fn()}
        disabledModes={['simple']}
      />
    )

    fireEvent.click(screen.getByTestId('simple-executor-custom-card'))

    expect(onChange).toHaveBeenCalledWith('custom')
  })

  it('keeps unselected choices visually framed as cards', () => {
    render(
      <ExecutorModeSelector
        value="complex"
        onChange={jest.fn()}
        shells={shells}
        customShellName=""
        onCustomShellChange={jest.fn()}
      />
    )

    expect(screen.getByTestId('simple-executor-custom-card')).toHaveClass(
      'border-border',
      'bg-base'
    )
    expect(screen.getByTestId('simple-executor-custom-card')).not.toHaveClass(
      'border-transparent',
      'bg-transparent'
    )
  })
})
