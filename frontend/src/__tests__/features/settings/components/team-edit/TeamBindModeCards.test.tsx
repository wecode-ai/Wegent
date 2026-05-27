// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import TeamBindModeCards from '@/features/settings/components/team-edit/TeamBindModeCards'
import type { TaskType } from '@/types/api'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common:team.bind_mode': 'Bind mode',
        'settings:team.simple.bind_mode.chat.title': 'Chat',
        'settings:team.simple.bind_mode.chat.description': 'Use for conversation.',
        'settings:team.simple.bind_mode.code.title': 'Code',
        'settings:team.simple.bind_mode.code.description': 'Use for repository tasks.',
        'settings:team.simple.bind_mode.task.title': 'Device',
        'settings:team.simple.bind_mode.task.description': 'Use for device tasks.',
      })[key] || key,
  }),
}))

describe('TeamBindModeCards', () => {
  it('renders only chat, code, and device choices with descriptions', () => {
    render(<TeamBindModeCards value={['chat']} onChange={jest.fn()} />)

    expect(screen.getByRole('checkbox', { name: /chat/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /code/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /device/i })).not.toBeChecked()
    expect(screen.getByText('Use for conversation.')).toBeInTheDocument()
    expect(screen.queryByText(/video/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/image/i)).not.toBeInTheDocument()
  })

  it('calls onChange with checked modes when toggled', () => {
    const onChange = jest.fn()

    render(<TeamBindModeCards value={['chat'] as TaskType[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /code/i }))

    expect(onChange).toHaveBeenCalledWith(['chat', 'code'])
  })
})
