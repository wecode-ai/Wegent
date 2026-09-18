import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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
    controls,
    projectWork,
    ...overrides,
  }
  const view = render(<TaskCommentComposer {...props} />)
  return { ...view, props, input: screen.getByTestId('cloud-task-activity-composer') }
}

describe('TaskCommentComposer', () => {
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

  it('submits with Enter while preserving Shift+Enter and IME composition', () => {
    const { props, input } = setup()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(props.onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSubmit).toHaveBeenCalledOnce()
  })

  it('disables submission for empty drafts, pending sends and uploads', () => {
    const { props, input, rerender } = setup({ value: ' ' })
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
    rerender(<TaskCommentComposer {...props} value="Review this" sending />)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onSubmit).not.toHaveBeenCalled()
    props.controls.uploadingFiles.set('notes.txt', {
      file: new File(['notes'], 'notes.txt'),
      progress: 50,
    })
    rerender(<TaskCommentComposer {...props} value="Review this" />)
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
  })

  it('uploads selected and pasted files through the existing attachment controls', () => {
    const { props, input } = setup()
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('task-comment-file-input'), { target: { files: [file] } })
    expect(props.controls.handleFileSelect).toHaveBeenCalledWith([file])
    fireEvent.paste(input, { clipboardData: { files: [file] } })
    expect(props.controls.handleFileSelect).toHaveBeenCalledTimes(2)
  })

  it('retains the draft and displays a send failure', () => {
    const { input } = setup({ error: 'Connection lost' })
    expect(input).toHaveValue('Review this')
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost')
  })
})
