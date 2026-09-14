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
                {
                  description: '使用已有智能体',
                  label: '已有智能体',
                  testId: 'mode-existing',
                  value: 'existing',
                },
                {
                  description: '使用标准表单',
                  label: '新建智能体',
                  testId: 'mode-create',
                  value: 'create',
                },
              ],
              value: 'existing',
            })}
            {webProjectAgentConfigurationHost.renderSelect({
              ariaLabel: '选择智能体',
              onChange: jest.fn(),
              options: [{ label: '研发团队', value: '12' }],
              placeholder: '选择智能体',
              testId: 'agent-select',
              value: '',
            })}
            {webProjectAgentConfigurationHost.renderTextControl({
              ariaLabel: '名称',
              onChange: jest.fn(),
              placeholder: '智能体名称',
              testId: 'agent-name',
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
    expect(screen.getByTestId('mode-existing-card')).toHaveClass(
      'border',
      'border-primary',
      'bg-primary/5',
      'ring-1'
    )
    expect(screen.getByTestId('mode-create-card')).toHaveClass('border-border', 'bg-base')
    expect(screen.getByTestId('agent-select')).toHaveClass('border-border', 'rounded-lg')
    expect(screen.getByTestId('agent-name')).toHaveClass('border-border', 'rounded-lg')
    expect(screen.getByTestId('agent-submit')).toHaveClass('bg-primary', 'rounded-lg')

    fireEvent.click(screen.getByTestId('mode-create'))
    expect(onModeChange).toHaveBeenCalledWith('create')
  })
})
