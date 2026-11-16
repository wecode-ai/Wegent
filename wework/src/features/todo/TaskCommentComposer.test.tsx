import type { ProjectChatControls, ProjectWorkControls } from '@/components/chat/ChatInput'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import i18n from '@/i18n'
import type { Attachment } from '@/types/api'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { describe, expect, it, vi } from 'vitest'
import { TaskCommentComposer } from './TaskCommentComposer'

function setup(overrides: Partial<Parameters<typeof TaskCommentComposer>[0]> = {}) {
  const controls: ProjectChatControls = {
    models: [],
    skills: [],
    selectedModel: null,
    selectedModelOptions: {},
    selectedSkills: [],
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
    isOptionsLocked: false,
    setSelectedModel: vi.fn(),
    setSelectedModelOption: vi.fn(),
    toggleSkill: vi.fn(),
    handleFileSelect: vi.fn(async () => {}),
    removeAttachment: vi.fn(async () => {}),
    listLocalSkills: vi.fn(async () => []),
  }
  const projectWork: ProjectWorkControls = {
    projects: [],
    devices: [],
    executionMode: 'current_workspace',
    onSelectProject: vi.fn(),
    onSelectStandaloneDevice: vi.fn(),
    onExecutionModeChange: vi.fn(),
  }
  const props = {
    value: 'Review this',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    disabled: false,
    sending: false,
    error: null,
    translate: createCollaborationTranslator('zh-CN'),
    controls,
    projectWork,
    ...overrides,
  }
  const view = render(<TaskCommentComposer {...props} />)
  return { ...view, props, input: screen.getByTestId('cloud-task-activity-composer') }
}

describe('TaskCommentComposer', () => {
  it('sends mentions without assigning and keeps the suggestion for explicit confirmation', async () => {
    const user = userEvent.setup()
    const assign = vi.fn().mockResolvedValue(undefined)
    const assignment = {
      options: [1, 2].map(userId => ({
        value: String(userId),
        label: `User ${userId}`,
      })),
      assign,
    }
    const { props, rerender } = setup({
      assignment,
      value: '[$@User 1](wework-member://1) [$@User 2](wework-member://2)',
    })
    const select = screen.getByTestId('task-comment-form-assignee')
    const send = screen.getByTestId('send-message-button')
    expect(select).toHaveAttribute('data-value', '')
    expect(screen.getByRole('group', { name: '转派建议：User 1' })).toBeInTheDocument()
    expect(screen.queryByText(/\{\{name\}\}/)).not.toBeInTheDocument()
    expect(select.nextElementSibling).toBe(send)
    expect(send).toHaveTextContent('发送消息')
    await user.click(send)
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled())
    expect(assign).not.toHaveBeenCalled()
    rerender(<TaskCommentComposer {...props} value="" />)
    expect(send).toBeDisabled()
    expect(select).toHaveAttribute('data-value', '')
    expect(screen.queryByTestId('task-comment-form-assignee-menu')).not.toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('task-comment-form-assignee-confirm'))
    expect(select).toHaveAttribute('data-value', '1')
    expect(assign).not.toHaveBeenCalled()
    expect(send).toHaveTextContent('转派')
    await user.click(send)
    await waitFor(() => expect(assign).toHaveBeenCalledWith('1'))
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('task-comment-form-assignee-menu')).not.toBeInTheDocument()
  })

  it.each([
    ['agent:bot', '代码助手'],
    ['resource:workspace-agent', '空间智能体'],
    ['team:42', 'Wegent 智能体'],
    ['group:squad', '协作小组'],
  ])('selects %s and assigns without posting an empty comment', async (value, label) => {
    const user = userEvent.setup()
    const assign = vi.fn().mockResolvedValue(undefined)
    const { props } = setup({ value: '', assignment: { options: [{ value, label }], assign } })
    const picker = screen.getByTestId('task-comment-form-assignee')
    await user.click(picker)
    await user.click(screen.getByTestId('task-comment-form-assignee-option-' + value))
    expect(picker).toHaveTextContent(label)
    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    expect(assign).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(assign).toHaveBeenCalledWith(value))
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('hides assignment when the host does not grant permission', () => {
    setup()
    expect(screen.queryByTestId('task-comment-form-assignee')).not.toBeInTheDocument()
  })

  it('retains a failed selected target and retries without creating an empty comment', async () => {
    const user = userEvent.setup()
    const assign = vi
      .fn()
      .mockRejectedValueOnce(new Error('Version conflict'))
      .mockResolvedValue(undefined)
    const { props, input } = setup({
      value: '',
      assignment: { options: [{ value: '2', label: 'User 2' }], assign },
    })
    await user.click(screen.getByTestId('task-comment-form-assignee'))
    await user.click(screen.getByTestId('task-comment-form-assignee-option-2'))
    await user.click(screen.getByTestId('send-message-button'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Version conflict')
    expect(screen.getByTestId('task-comment-form')).toContainElement(screen.getByRole('alert'))
    expect(screen.queryByTestId('task-comment-form-assignee-menu')).not.toBeInTheDocument()
    expect(input).toHaveValue('')
    await user.click(screen.getByTestId('send-message-button'))
    await waitFor(() =>
      expect(screen.getByTestId('task-comment-form-assignee')).toHaveAttribute('data-value', '')
    )
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledTimes(2)
  })

  it('dismisses a mention suggestion without changing the selected target', async () => {
    const user = userEvent.setup()
    const assign = vi.fn()
    setup({
      value: '[$@User 2](wework-member://2)',
      assignment: { options: [{ value: '2', label: 'User 2' }], assign },
    })
    await user.click(screen.getByTestId('task-comment-form-assignee-dismiss'))
    expect(screen.queryByRole('group', { name: '转派建议：User 2' })).not.toBeInTheDocument()
    expect(screen.getByTestId('task-comment-form-assignee')).toHaveAttribute('data-value', '')
    expect(assign).not.toHaveBeenCalled()
  })

  it('switches the suggestion by clicking a blue mention chip without filling the selector', async () => {
    const user = userEvent.setup()
    const assign = vi.fn()
    const { container } = setup({
      value: '[$@User 1](wework-member://1) [$@User 2](wework-member://2)',
      assignment: {
        options: [
          { value: '1', label: 'User 1' },
          { value: '2', label: 'User 2' },
        ],
        assign,
      },
    })
    const second = container.querySelector<HTMLElement>(
      '[data-composer-reference-kind="member"][data-composer-skill-reference*="wework-member://2"]'
    )!
    await user.click(second)
    expect(screen.getByRole('group', { name: '转派建议：User 2' })).toBeInTheDocument()
    expect(screen.getByTestId('task-comment-form-assignee')).toHaveAttribute('data-value', '')
    expect(assign).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('task-comment-form-assignee-confirm'))
    expect(screen.getByTestId('task-comment-form-assignee')).toHaveAttribute('data-value', '2')
    expect(screen.getByTestId('send-message-button')).toHaveTextContent('发送并转派')
    expect(assign).not.toHaveBeenCalled()
  })

  it('updates mention activation when assignment becomes available or blocked', async () => {
    const user = userEvent.setup()
    const assign = vi.fn()
    const { container, props, rerender } = setup({
      disabled: true,
      value: '[$@User 1](wework-member://1) [$@User 2](wework-member://2)',
      assignment: {
        options: [
          { value: '1', label: 'User 1' },
          { value: '2', label: 'User 2' },
        ],
        assign,
      },
    })
    const second = () =>
      container.querySelector<HTMLElement>(
        '[data-composer-reference-kind="member"][data-composer-skill-reference*="wework-member://2"]'
      )!
    expect(second()).not.toHaveAttribute('role', 'button')
    rerender(<TaskCommentComposer {...props} disabled={false} />)
    expect(second()).toHaveAttribute('role', 'button')
    expect(second()).toHaveAttribute('tabindex', '0')
    await user.click(second())
    expect(screen.getByRole('group', { name: '转派建议：User 2' })).toBeInTheDocument()
    await user.click(screen.getByTestId('task-comment-form-assignee-dismiss'))
    second().focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('group', { name: '转派建议：User 2' })).toBeInTheDocument()
    expect(props.onSubmit).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('task-comment-form-assignee-dismiss'))
    rerender(<TaskCommentComposer {...props} disabled />)
    expect(second()).not.toHaveAttribute('role', 'button')
    expect(second()).not.toHaveAttribute('tabindex', '0')
    await user.click(second())
    expect(screen.queryByRole('group', { name: '转派建议：User 2' })).not.toBeInTheDocument()
    expect(screen.getByTestId('task-comment-form-assignee')).toHaveAttribute('data-value', '')
    expect(assign).not.toHaveBeenCalled()
  })

  it('disables the send button for empty drafts, pending sends and uploads', () => {
    const { props, rerender } = setup({ value: ' ' })
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
    rerender(<TaskCommentComposer {...props} value="Review this" sending />)
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
    props.controls.uploadingFiles.set('notes.txt', {
      file: new File(['notes'], 'notes.txt'),
      progress: 50,
    })
    rerender(<TaskCommentComposer {...props} value="Review this" />)
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
  })

  it('uploads selected and pasted files through the existing attachment controls', async () => {
    const { props, input } = setup()
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('task-comment-file-input'), { target: { files: [file] } })
    expect(props.controls.handleFileSelect).toHaveBeenCalledWith([file])
    fireEvent.paste(input, { clipboardData: { files: [file] } })
    await waitFor(() => expect(props.controls.handleFileSelect).toHaveBeenCalledTimes(2))
  })

  it('retains the draft and displays a send failure', () => {
    const { input } = setup({ error: 'Connection lost' })
    expect(input).toHaveValue('Review this')
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost')
  })

  it.each([
    ['zh-CN', '关闭附件错误'],
    ['en', 'Dismiss attachment error'],
  ])(
    'dismisses failed attachments in %s while retaining the draft and valid files',
    async (language, label) => {
      const { props, rerender } = setup()
      const uploadAttachment = vi.fn().mockRejectedValue(new Error('disk full'))
      let controls!: ReturnType<typeof useWorkbenchAttachments>
      const valid: Attachment = {
        id: -42,
        filename: 'valid.pdf',
        file_size: 4,
        mime_type: 'application/pdf',
        file_extension: '.pdf',
        created_at: '2026-10-27T00:00:00Z',
        status: 'ready',
      }
      function Harness() {
        controls = useWorkbenchAttachments({ uploadAttachment })
        return <TaskCommentComposer {...props} controls={{ ...props.controls, ...controls }} />
      }
      try {
        await act(async () => {
          await i18n.changeLanguage(language)
        })
        rerender(<Harness />)
        await act(async () => {
          controls.addExistingAttachment(valid)
          await controls.handleFileSelect(new File(['test'], 'failed.pdf'))
        })
        expect(screen.getByTestId('attachment-error-badge')).toHaveTextContent('disk full')

        await userEvent.click(screen.getByRole('button', { name: label }))

        expect(screen.queryByTestId('attachment-error-badge')).not.toBeInTheDocument()
        expect(screen.getByTestId('cloud-task-activity-composer')).toHaveValue('Review this')
        expect(screen.getByTestId('attachment-badge')).toHaveTextContent('valid.pdf')
        expect(controls.errors.size).toBe(0)
        expect(controls.attachments).toEqual([valid])
      } finally {
        await act(async () => {
          await i18n.changeLanguage('zh-CN')
        })
      }
    }
  )
})
