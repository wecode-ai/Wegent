// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { webProjectAgentConfigurationHost } from '@/features/collaboration/ProjectAgentConfigurationHost'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const dialogProps = {
  busy: false,
  closeLabel: '关闭',
  description: '选择一个智能体，加入后即可分配项目任务。',
  onClose: jest.fn(),
  testIds: { backdrop: 'agent-backdrop', close: 'agent-close', dialog: 'agent-dialog' },
  title: '添加智能体',
  children: <input aria-label="搜索智能体" type="search" />,
}

describe('webProjectAgentConfigurationHost', () => {
  it('presents a compact dialog with purpose copy and focuses search', () => {
    const onClose = jest.fn()
    render(webProjectAgentConfigurationHost.renderDialog({ ...dialogProps, onClose }))

    expect(screen.getByRole('dialog', { name: '添加智能体' })).toHaveAccessibleDescription(
      dialogProps.description
    )
    expect(screen.getByTestId('agent-backdrop')).toHaveClass('bg-black/[0.14]')
    expect(screen.getByTestId('agent-dialog')).toHaveClass(
      'sm:max-w-[520px]',
      'sm:rounded-[20px]',
      'gap-0',
      'overflow-hidden',
      'p-0'
    )
    expect(screen.getByRole('searchbox', { name: '搜索智能体' })).toHaveFocus()
    fireEvent.click(screen.getByTestId('agent-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending addition open until it settles', () => {
    const onClose = jest.fn()
    const { rerender } = render(
      webProjectAgentConfigurationHost.renderDialog({ ...dialogProps, busy: true, onClose })
    )
    expect(screen.getByTestId('agent-close')).toBeDisabled()
    fireEvent.click(screen.getByTestId('agent-close'))
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    rerender(webProjectAgentConfigurationHost.renderDialog({ ...dialogProps, onClose }))
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
