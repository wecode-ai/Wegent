import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { weworkProjectAgentConfigurationHost } from './WeworkProjectAgentConfigurationHost'

describe('weworkProjectAgentConfigurationHost', () => {
  it('renders the shared Agent form with Wework design-system controls', () => {
    const onClose = vi.fn()
    const onModeChange = vi.fn()
    const onNameChange = vi.fn()

    render(
      weworkProjectAgentConfigurationHost.renderDialog({
        busy: false,
        closeLabel: '关闭',
        description: '选择已有智能体，或新建智能体。',
        onClose,
        testIds: {
          backdrop: 'agent-backdrop',
          close: 'agent-close',
          dialog: 'agent-dialog',
        },
        title: '添加智能体',
        children: (
          <>
            {weworkProjectAgentConfigurationHost.renderModePicker({
              onChange: onModeChange,
              options: [
                {
                  description: '使用已有智能体',
                  disabled: true,
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
              value: 'create',
            })}
            {weworkProjectAgentConfigurationHost.renderTextControl({
              ariaLabel: '名称',
              onChange: onNameChange,
              placeholder: '智能体名称',
              testId: 'agent-name',
              value: '',
            })}
            {weworkProjectAgentConfigurationHost.renderPrimaryAction({
              children: '创建智能体',
              disabled: false,
              onClick: vi.fn(),
              testId: 'agent-submit',
            })}
          </>
        ),
      })
    )

    expect(screen.getByTestId('agent-dialog')).toHaveClass(
      'max-w-4xl',
      'rounded-[20px]',
      'bg-popover'
    )
    expect(screen.getByTestId('mode-existing')).toBeDisabled()
    expect(screen.getByTestId('mode-existing-card')).toHaveClass('cursor-not-allowed', 'opacity-45')
    expect(screen.getByTestId('mode-create-card')).toHaveClass(
      'border-focus',
      'bg-focus/5',
      'ring-1'
    )
    expect(screen.getByTestId('agent-name')).toHaveClass(
      'rounded-lg',
      'border-border',
      'bg-background'
    )
    expect(screen.getByTestId('agent-submit')).toHaveClass('rounded-lg', 'bg-text-primary')

    fireEvent.click(screen.getByTestId('mode-existing'))
    expect(onModeChange).not.toHaveBeenCalled()

    fireEvent.change(screen.getByTestId('agent-name'), { target: { value: '代码评审' } })
    expect(onNameChange).toHaveBeenCalledWith('代码评审')

    fireEvent.click(screen.getByTestId('agent-close'))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
