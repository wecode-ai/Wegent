import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import '@/i18n'
import type { ProjectChatControls, ProjectWorkControls } from '@/components/chat/ChatInput'
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
  it('places the first mentioned assignee next to Send and allows assignment without text', async () => {
    const user = userEvent.setup()
    const assign = vi.fn().mockResolvedValue(undefined)
    const assignment = {
      members: [1, 2].map(user_id => ({
        user_id,
        user_name: `User ${user_id}`,
        role: 'Developer',
      })) as import('@wegent/collaboration').CollaborationMember[],
      assign,
    }
    const { props, rerender } = setup({
      assignment,
      value: '[$@User 1](wework-member://1) [$@User 2](wework-member://2)',
    })
    const select = screen.getByTestId('task-comment-form-assignee')
    const send = screen.getByTestId('send-message-button')
    expect(select).toHaveAttribute('data-value', '1')
    expect(select.nextElementSibling).toBe(send)
    expect(send).toHaveTextContent('发送并转派')
    await user.click(select)
    await user.click(screen.getByTestId('task-comment-form-assignee-option-2'))
    rerender(<TaskCommentComposer {...props} value="" />)
    expect(send).toHaveTextContent('转派')
    expect(send).toBeEnabled()
    await user.click(send)
    await waitFor(() => expect(assign).toHaveBeenCalledWith(2))
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('hides assignment when the host does not grant permission', () => {
    setup()
    expect(screen.queryByTestId('task-comment-form-assignee')).not.toBeInTheDocument()
  })

  it('keeps execution settings collapsed without replacing the draft when toggled', async () => {
    const user = userEvent.setup()
    const { input } = setup()
    const toggle = screen.getByTestId('task-comment-settings-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(input).toHaveValue('Review this')
    expect(screen.queryByTestId('project-chat-composer')).not.toBeInTheDocument()
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
})
