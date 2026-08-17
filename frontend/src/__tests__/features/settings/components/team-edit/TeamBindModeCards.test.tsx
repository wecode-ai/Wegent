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
        'settings:team.simple.bind_mode.video.title': 'Video',
        'settings:team.simple.bind_mode.video.description': 'Use for video tasks.',
        'settings:team.simple.bind_mode.image.title': 'Image',
        'settings:team.simple.bind_mode.image.description': 'Use for image tasks.',
        'settings:team.simple.bind_mode.more_modes': 'More modes',
        'settings:team.simple.bind_mode.collapse_more_modes': 'Collapse more modes',
      })[key] || key,
  }),
}))

describe('TeamBindModeCards', () => {
  it('hides less common bind modes by default', () => {
    render(<TeamBindModeCards value={['chat']} onChange={jest.fn()} />)

    expect(screen.getByRole('checkbox', { name: /chat/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /code/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /device/i })).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: /video/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /image/i })).not.toBeInTheDocument()
    expect(screen.getByText('Use for conversation.')).toBeInTheDocument()
  })

  it('shows video and image modes after expanding more modes', () => {
    render(<TeamBindModeCards value={['chat']} onChange={jest.fn()} />)

    fireEvent.click(screen.getByTestId('team-bind-mode-more-toggle'))

    expect(screen.getByRole('checkbox', { name: /video/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /image/i })).not.toBeChecked()
    expect(screen.getByText('Use for video tasks.')).toBeInTheDocument()
    expect(screen.getByText('Use for image tasks.')).toBeInTheDocument()
  })

  it('automatically expands when an advanced mode is selected', () => {
    render(<TeamBindModeCards value={['chat', 'image']} onChange={jest.fn()} />)

    expect(screen.getByRole('checkbox', { name: /image/i })).toBeChecked()
    expect(screen.getByTestId('team-bind-mode-more-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('calls onChange with checked modes when toggled', () => {
    const onChange = jest.fn()

    render(<TeamBindModeCards value={['chat'] as TaskType[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /code/i }))

    expect(onChange).toHaveBeenCalledWith(['chat', 'code'])
  })

  it('toggles a bind mode when the card is clicked', () => {
    const onChange = jest.fn()

    render(<TeamBindModeCards value={['chat'] as TaskType[]} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('simple-bind-mode-code-card'))

    expect(onChange).toHaveBeenCalledWith(['chat', 'code'])
  })

  it('adds video and image bind modes', () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <TeamBindModeCards value={['chat'] as TaskType[]} onChange={onChange} />
    )

    fireEvent.click(screen.getByTestId('team-bind-mode-more-toggle'))
    fireEvent.click(screen.getByTestId('simple-bind-mode-video-card'))
    expect(onChange).toHaveBeenLastCalledWith(['chat', 'video'])

    rerender(<TeamBindModeCards value={['chat', 'video']} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('simple-bind-mode-image-card'))
    expect(onChange).toHaveBeenLastCalledWith(['chat', 'video', 'image'])
  })

  it('keeps unselected choices visually framed as cards', () => {
    render(<TeamBindModeCards value={['chat']} onChange={jest.fn()} />)

    expect(screen.getByTestId('simple-bind-mode-code-card')).toHaveClass('border-border', 'bg-base')
    expect(screen.getByTestId('simple-bind-mode-code-card')).not.toHaveClass(
      'border-transparent',
      'bg-transparent'
    )
  })
})
