import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { Attachment, ProjectWithTasks, SkillRef, UnifiedModel, UnifiedSkill } from '@/types/api'
import { ChatInput } from './ChatInput'
import type { ProjectChatControls, ProjectWorkControls } from './ChatInput'

function ControlledChatInput({
  onSubmit = vi.fn(),
}: {
  onSubmit?: () => void
}) {
  const [value, setValue] = useState('')

  return <ChatInput value={value} onChange={setValue} onSubmit={onSubmit} disabled={false} />
}

function projectChatControls(overrides: Partial<ProjectChatControls> = {}): ProjectChatControls {
  return {
    models: [],
    skills: [],
    selectedModel: null,
    selectedSkills: [],
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
    isOptionsLocked: false,
    setSelectedModel: vi.fn(),
    toggleSkill: vi.fn(),
    handleFileSelect: vi.fn().mockResolvedValue(undefined),
    removeAttachment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function projectWorkControls(overrides: Partial<ProjectWorkControls> = {}): ProjectWorkControls {
  return {
    projects: [],
    currentProjectId: undefined,
    onSelectProject: vi.fn(),
    ...overrides,
  }
}

describe('ChatInput', () => {
  test('renders the desktop composer sections', () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} variant="desktop" />,
    )

    expect(screen.getByTestId('chat-message-input')).toHaveAttribute('rows', '2')
    expect(screen.queryByTestId('custom-mode-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument()
    expect(screen.getByTestId('skill-selector-button')).toBeInTheDocument()
    expect(screen.getByTestId('project-work-button')).toBeInTheDocument()
  })

  test('opens the desktop model menu with real model options', async () => {
    const model: UnifiedModel = {
      name: 'gpt-5.5-medium',
      type: 'user',
      displayName: 'GPT 5.5 Medium',
    }
    const setSelectedModel = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          models: [model],
          setSelectedModel,
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByText('选择模型')).toBeInTheDocument()
    expect(screen.getByText('GPT 5.5 Medium')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('model-option-gpt-5.5-medium'))

    expect(setSelectedModel).toHaveBeenCalledWith(model)
  })

  test('opens the desktop skill menu and toggles a skill', async () => {
    const skill: UnifiedSkill = {
      id: 1,
      name: 'project-summary',
      namespace: 'default',
      description: 'Summarize project context',
      is_active: true,
      is_public: false,
      user_id: 1,
    }
    const toggleSkill = vi.fn()
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          skills: [skill],
          toggleSkill,
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('skill-selector-button'))

    expect(screen.getByTestId('skill-selector-menu')).toBeInTheDocument()
    expect(screen.getByText('选择技能')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('skill-option-project-summary'))

    expect(toggleSkill).toHaveBeenCalledWith({
      name: 'project-summary',
      namespace: 'default',
      is_public: false,
    })
  })

  test('opens the desktop add context menu with only file upload', async () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} variant="desktop" />,
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('add-context-menu')).toBeInTheDocument()
    expect(screen.getByText('添加照片和文件')).toBeInTheDocument()
    expect(screen.queryByText('Attach Google Chrome')).not.toBeInTheDocument()
    expect(screen.queryByText('计划模式')).not.toBeInTheDocument()
    expect(screen.queryByText('追求目标')).not.toBeInTheDocument()
    expect(screen.queryByText('插件')).not.toBeInTheDocument()
  })

  test('renders attachment badges and removes an attachment', async () => {
    const removeAttachment = vi.fn().mockResolvedValue(undefined)
    const attachment: Attachment = {
      id: 42,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          attachments: [attachment],
          removeAttachment,
        })}
      />,
    )

    expect(screen.getByTestId('attachment-badge')).toHaveTextContent('brief.pdf')

    await userEvent.click(screen.getByTestId('remove-attachment-button'))

    expect(removeAttachment).toHaveBeenCalledWith(42)
  })

  test('renders an image preview for image attachments', () => {
    const attachment: Attachment = {
      id: 43,
      filename: 'screenshot.png',
      file_size: 1200,
      mime_type: 'image/png',
      status: 'ready',
      file_extension: '.png',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />,
    )

    expect(screen.getByTestId('attachment-image-preview')).toHaveAttribute(
      'src',
      '/api/attachments/43/download'
    )
  })

  test('enables send when only attachments are present', async () => {
    const onSubmit = vi.fn()
    const attachment: Attachment = {
      id: 44,
      filename: 'brief.pdf',
      file_size: 1200,
      mime_type: 'application/pdf',
      status: 'ready',
      file_extension: '.pdf',
      created_at: '2026-05-27T00:00:00.000Z',
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({ attachments: [attachment] })}
      />,
    )

    expect(screen.getByTestId('send-message-button')).toBeEnabled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('opens project work menu and selects a project', async () => {
    const onSelectProject = vi.fn()
    const projects: ProjectWithTasks[] = [
      { id: 7, name: 'Wegent', tasks: [] },
      { id: 8, name: 'Docs', tasks: [] },
    ]

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects,
          currentProjectId: 7,
          onSelectProject,
        })}
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('project-work-menu')).toBeInTheDocument()
    expect(screen.getAllByText('Wegent').length).toBeGreaterThan(0)
    expect(screen.getByText('Docs')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-option-8'))

    expect(onSelectProject).toHaveBeenCalledWith(8)
  })

  test('disables model and skill selectors when options are locked', () => {
    const selectedSkill: SkillRef = {
      name: 'project-summary',
      namespace: 'default',
      is_public: false,
    }

    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectChat={projectChatControls({
          selectedSkills: [selectedSkill],
          isOptionsLocked: true,
        })}
      />,
    )

    expect(screen.getByTestId('model-selector-button')).toBeDisabled()
    expect(screen.getByTestId('skill-selector-button')).toBeDisabled()
  })

  test.each([
    ['model selector', 'model-selector-button', 'model-selector-menu'],
    ['add context menu', 'add-context-button', 'add-context-menu'],
    ['project work menu', 'project-work-button', 'project-work-menu'],
  ])('closes the desktop %s when clicking outside the dropdown', async (_, buttonTestId, menuTestId) => {
    render(
      <ChatInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        variant="desktop"
        projectWork={projectWorkControls({
          projects: [{ id: 7, name: 'Wegent', tasks: [] }],
        })}
      />,
    )

    await userEvent.click(screen.getByTestId(buttonTestId))
    expect(screen.getByTestId(menuTestId)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('chat-message-input'))

    expect(screen.queryByTestId(menuTestId)).not.toBeInTheDocument()
  })

  test('submits typed content', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<ChatInput value="hello" onChange={onChange} onSubmit={onSubmit} disabled={false} />)

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalled()
  })

  test('submits with Enter when content is present', async () => {
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello{enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('keeps Shift Enter as a newline', async () => {
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} />)

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, 'hello{shift>}{enter}{/shift}world')

    expect(input).toHaveValue('hello\nworld')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
