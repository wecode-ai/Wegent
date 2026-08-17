import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import { IssueComposer } from './IssueComposer'
import { issueDraftFromText } from './issueComposerDraft'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

const workItemProject = {
  id: 'default-work-items',
  public_id: 'default-work-items',
  project_key: 'WORK',
  name: '我的任务',
  description: '',
  project_store: 'local' as const,
  task_provider: 'local' as const,
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '',
  updated_at: '',
}

function renderWithProjectChat(
  component: React.ReactNode,
  overrides: Partial<ProjectChatControls> = {}
) {
  const projectChat: ProjectChatControls = {
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
    handleFileSelect: vi.fn(async () => undefined),
    removeAttachment: vi.fn(async () => undefined),
    listLocalSkills: vi.fn(async () => []),
    ...overrides,
  }
  return render(
    <WorkbenchPaneContext.Provider value={{ projectChat } as unknown as WorkbenchPaneContextValue}>
      {component}
    </WorkbenchPaneContext.Provider>
  )
}

describe('IssueComposer', () => {
  it('derives a compact task-style title and preserves the complete content', () => {
    expect(issueDraftFromText('完成发布验证\n覆盖创建和完成链路\n补充截图')).toEqual({
      title: '完成发布验证 覆盖创建和完成链路 补充截图',
      description: '完成发布验证\n覆盖创建和完成链路\n补充截图',
    })
  })

  it('uses the same title length limit as task mode', () => {
    const description = '需要处理的任务'.repeat(20)

    expect(issueDraftFromText(description)).toEqual({
      title: `${Array.from(description).slice(0, 59).join('')}…`,
      description,
    })
  })

  it('creates a lightweight issue without requiring a local execution project', async () => {
    const onCreate = vi.fn()
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        localProjects={[
          { id: 91, name: 'Wegent' },
          { id: 92, name: 'ChatGPT' },
        ]}
        initialLocalProjectId={91}
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    expect(screen.getByTestId('workspace-create-issue-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.queryByText('描述要推进的事情，创建后自动进入所选看板。')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-work-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-selector-button')).not.toBeInTheDocument()
    await userEvent.type(screen.getByTestId('workspace-issue-input'), '修复工作空间创建入口')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}只创建 Issue')
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '修复工作空间创建入口 只创建 Issue',
      description: '修复工作空间创建入口\n只创建 Issue',
      files: [],
      createTask: false,
      localProjectId: null,
    })
  })

  it('switches to the full task composer without losing the issue content', async () => {
    const onCreate = vi.fn()
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        localProjects={[
          { id: 91, name: 'Wegent' },
          { id: 92, name: 'ChatGPT' },
        ]}
        initialLocalProjectId={91}
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    await userEvent.type(screen.getByTestId('workspace-issue-input'), '修复创建流程')
    await userEvent.click(screen.getByTestId('workspace-create-task-tab'))

    expect(screen.getByTestId('workspace-create-task-tab')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('workspace-issue-input')).toHaveTextContent('修复创建流程')
    expect(screen.getByTestId('project-work-button')).toHaveTextContent('Wegent')
    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('project-option-92'))
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '修复创建流程',
      description: '修复创建流程',
      files: [],
      createTask: true,
      localProjectId: 92,
    })
  })

  it('supports the command-enter shortcut', async () => {
    const onCreate = vi.fn()
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    const input = screen.getByTestId('workspace-issue-input')
    fireEvent.change(input, { target: { value: '快捷创建 Issue' } })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '快捷创建 Issue',
      description: '快捷创建 Issue',
      files: [],
      createTask: false,
      localProjectId: null,
    })
  })

  it('can open directly in task creation mode', async () => {
    const onCreate = vi.fn()
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        initialStartExecution
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    await userEvent.type(screen.getByTestId('workspace-issue-input'), '完成发布验证')
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '完成发布验证',
      description: '完成发布验证',
      files: [],
      createTask: true,
      localProjectId: null,
    })
  })

  it('reuses the desktop task composer instead of a separate issue form', () => {
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-chat-composer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
  })

  it('stages attachments with the shared composer and includes them in issue creation', async () => {
    const onCreate = vi.fn()
    const file = new File(['release context'], 'release.md', { type: 'text/markdown' })
    renderWithProjectChat(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    fireEvent.change(screen.getByTestId('attachment-file-input'), {
      target: { files: [file] },
    })
    await userEvent.type(screen.getByTestId('workspace-issue-input'), '完成发布验证')
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '完成发布验证',
      description: '完成发布验证',
      files: [file],
      createTask: false,
      localProjectId: null,
    })
  })

  it('closes with Escape without showing a duplicate cancel action', () => {
    const onCancel = vi.fn()
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={onCancel}
        onCreate={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('workspace-issue-input'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('closes a popup by clicking the backdrop without closing from panel clicks', () => {
    const onCancel = vi.fn()
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        presentation="popup"
        onCancel={onCancel}
        onCreate={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('workspace-issue-composer-panel'))
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('workspace-issue-composer'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
