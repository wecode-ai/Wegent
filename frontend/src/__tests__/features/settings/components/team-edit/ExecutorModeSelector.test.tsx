// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import type { UnifiedShell } from '@/apis/shells'
import ExecutorModeSelector from '@/features/settings/components/team-edit/ExecutorModeSelector'

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
        'settings:team.simple.executor.custom.description': 'Choose a custom shell.',
        'settings:team.simple.executor.custom_shell_placeholder': 'Choose custom shell',
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
