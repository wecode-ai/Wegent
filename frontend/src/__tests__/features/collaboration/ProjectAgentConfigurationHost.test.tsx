// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { webProjectAgentConfigurationHost } from '@/features/collaboration/ProjectAgentConfigurationHost'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('webProjectAgentConfigurationHost', () => {
  it('renders project Agent controls with the existing web design system', () => {
    const onModeChange = jest.fn()
    const onTextChange = jest.fn()

    render(
      webProjectAgentConfigurationHost.renderDialog({
        busy: false,
        closeLabel: '关闭',
        description: '选择已有智能体',
        onClose: jest.fn(),
        testIds: {
          backdrop: 'agent-backdrop',
          close: 'agent-close',
          dialog: 'agent-dialog',
        },
        title: '添加智能体',
        children: (
          <>
            {webProjectAgentConfigurationHost.renderModePicker({
              onChange: onModeChange,
              options: [
                { label: 'Wegent', testId: 'mode-wegent', value: 'wegent' },
                { label: 'Codex', testId: 'mode-codex', value: 'codex' },
              ],
              value: 'wegent',
            })}
            {webProjectAgentConfigurationHost.renderTextControl({
              ariaLabel: '智能体名称',
              onChange: onTextChange,
              placeholder: '输入名称',
              testId: 'agent-name',
              value: '',
            })}
            {webProjectAgentConfigurationHost.renderSelect({
              ariaLabel: '选择智能体',
              onChange: jest.fn(),
              options: [{ label: '研发团队', value: '12' }],
              placeholder: '选择智能体',
              testId: 'agent-select',
              value: '',
            })}
            {webProjectAgentConfigurationHost.renderPrimaryAction({
              children: '加入项目',
              disabled: false,
              onClick: jest.fn(),
              testId: 'agent-submit',
            })}
          </>
        ),
      })
    )

    expect(screen.getByTestId('agent-backdrop')).toHaveClass('bg-black/80')
    expect(screen.getByTestId('agent-dialog')).toHaveClass(
      'bg-base',
      'gap-0',
      'overflow-hidden',
      'p-0',
      'sm:max-w-[520px]'
    )
    expect(screen.getByTestId('mode-wegent').parentElement).toHaveClass(
      'h-9',
      'border',
      'border-border',
      'bg-surface',
      'p-0.5'
    )
    expect(screen.getByTestId('mode-wegent')).toHaveClass('h-8', 'text-sm')
    expect(screen.getByTestId('agent-select')).toHaveClass('border-border', 'rounded-lg')
    expect(screen.getByTestId('agent-submit')).toHaveClass('bg-primary', 'rounded-lg')

    fireEvent.mouseDown(screen.getByTestId('mode-codex'), { button: 0 })
    expect(onModeChange).toHaveBeenCalledWith('codex')

    fireEvent.change(screen.getByTestId('agent-name'), {
      target: { value: 'Codex 产品工程师' },
    })
    expect(onTextChange).toHaveBeenCalledWith('Codex 产品工程师')
  })
})
