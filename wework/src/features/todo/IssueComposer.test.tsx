import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import type { RuntimeWorkListResponse } from '@/types/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { issueDraftFromText } from '@wegent/collaboration'
import { describe, expect, it, vi } from 'vitest'
import { IssueComposer } from './IssueComposer'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
    i18n: { language: 'zh-CN' },
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
    <WorkbenchPaneContext.Provider
      value={
        {
          projectChat,
          projectExecutionMode: 'current_workspace',
          projectWorktreeBranch: null,
        } as unknown as WorkbenchPaneContextValue
      }
    >
      {component}
    </WorkbenchPaneContext.Provider>
  )
}

async function replaceIssueDescription(value: string) {
  const user = userEvent.setup()
  const editor = screen.getByTestId('workspace-issue-description')
  await user.click(editor)
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await user.keyboard('{Backspace}')
  await waitFor(() => expect(editor).not.toHaveTextContent(/\S/))
  if (value) {
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? value : ''),
      },
    })
    await waitFor(() => expect(editor).toHaveTextContent(value))
  }
  return editor
}

describe('IssueComposer', () => {
  it('preserves a long issue title without truncation', () => {
    const description = '需要处理的任务'.repeat(20)

    expect(issueDraftFromText(description)).toEqual({
      title: description,
      description,
    })
  })

  it('creates a lightweight personal task without requiring a local execution project', async () => {
    const onCreate = vi.fn()
    renderWithProjectChat(
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
    expect(screen.getByTestId('workspace-issue-heading')).toHaveTextContent('要记录什么？')
    expect(screen.getByText('先记录到我的任务，准备好后再推进或开始执行。')).toBeVisible()
    expect(screen.getByTestId('workspace-create-issue-tab')).toHaveTextContent('添加任务')
    expect(screen.getByTestId('workspace-create-task-tab')).toHaveTextContent('创建并执行')
    expect(screen.getByTestId('workspace-issue-creation-mode-description')).toHaveTextContent(
      '先加入看板，稍后再补充负责人或启动执行。'
    )
    expect(screen.queryByText('描述要推进的事情，创建后自动进入所选看板。')).not.toBeInTheDocument()
    const expandButton = screen.getByTestId('workspace-issue-expand')
    expect(screen.getByTestId('workspace-issue-composer-input-shell')).toContainElement(
      expandButton
    )
    expect(expandButton).toHaveAccessibleName('全屏编辑')
    expect(expandButton).toHaveClass('hover:bg-muted', 'hover:text-text-primary')
    expect(screen.queryByTestId('project-work-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-selector-button')).not.toBeInTheDocument()
    const compactProjectSelect = screen.getByTestId('workspace-issue-project-compact')
    expect(screen.getByTestId('composer-toolbar')).toContainElement(compactProjectSelect)
    expect(compactProjectSelect.closest('label')).toHaveClass('text-sm', 'font-normal')
    expect(screen.getByTestId('workspace-issue-composer-input-shell')).toHaveClass('font-normal')
    await userEvent.type(screen.getByTestId('workspace-issue-input'), '修复工作空间创建入口')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}只创建 Issue')
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '修复工作空间创建入口 只创建 Issue',
      description: '修复工作空间创建入口\n只创建 Issue',
      files: [],
      createTask: false,
    })
  })

  it('switches to the full task composer without losing the issue content', async () => {
    const onCreate = vi.fn()
    renderWithProjectChat(
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

    const input = screen.getByTestId('workspace-issue-input')
    await userEvent.click(input)
    fireEvent.paste(input, {
      clipboardData: {
        files: [],
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? '修复创建流程' : ''),
      },
    })
    expect(input).toHaveTextContent('修复创建流程')
    await userEvent.click(screen.getByTestId('workspace-create-task-tab'))

    expect(screen.getByTestId('workspace-create-task-tab')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('workspace-issue-heading')).toHaveTextContent('要执行什么？')
    expect(screen.getByTestId('workspace-issue-input')).toHaveTextContent('修复创建流程')
    expect(screen.queryByTestId('workspace-issue-project-compact')).not.toBeInTheDocument()
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
      taskRequest: {
        schemaVersion: 2,
        runtime: 'codex',
        message: '修复创建流程',
        modelOptions: { collaborationMode: 'default' },
        modelSelection: null,
        additionalSkills: [],
      },
    })
  })

  it('selects a cloud runtime project and captures its concrete workspace target', async () => {
    const onCreate = vi.fn()
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: {
            key: 'remote:docs',
            name: '文档',
            kind: 'remote',
            source: 'remote_project',
            stateDeviceId: 'cloud-state-device',
          },
          deviceWorkspaces: [
            {
              id: 71,
              projectId: null,
              deviceId: 'cloud-state-device',
              remoteHostId: 'cloud-executor',
              deviceName: 'Cloud Executor',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/workspace/docs',
              workspaceKind: 'workspace',
              workspaceSource: 'remote',
              mapped: true,
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const cloudProjectId = runtimeProjectUiId(runtimeWork.projects[0].project)
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
    }

    render(
      <WorkbenchPaneContext.Provider
        value={
          {
            projectChat,
            projectExecutionMode: 'current_workspace',
            projectWorktreeBranch: null,
            state: { runtimeWork },
          } as unknown as WorkbenchPaneContextValue
        }
      >
        <IssueComposer
          projects={[workItemProject]}
          initialBoardKey="backend:1"
          initialStartExecution
          localProjects={[{ id: 91, name: '本地项目' }]}
          initialLocalProjectId={91}
          onCancel={vi.fn()}
          onCreate={onCreate}
        />
      </WorkbenchPaneContext.Provider>
    )

    await userEvent.type(screen.getByTestId('workspace-issue-input'), '处理云端项目')
    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId(`project-option-${cloudProjectId}`))

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('文档')

    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '处理云端项目',
      description: '处理云端项目',
      files: [],
      createTask: true,
      taskRequest: {
        schemaVersion: 2,
        runtime: 'codex',
        message: '处理云端项目',
        deviceId: 'cloud-executor',
        execution: { workspace: { source: 'git_worktree' } },
        runtimeProjectKey: 'remote:docs',
        runtimeProjectName: '文档',
        runtimeWorkspaceRoots: [],
        modelOptions: { collaborationMode: 'default' },
        modelSelection: null,
        additionalSkills: [],
      },
    })
  })

  it('restores a saved draft with staged attachments after an accidental close', async () => {
    const onCancel = vi.fn()
    const file = new File(['image'], 'draft.png', { type: 'image/png' })
    const firstRender = render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={onCancel}
        onCreate={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-issue-expand'))
    fireEvent.change(screen.getByTestId('workspace-issue-title'), {
      target: { value: '未完成的 Issue' },
    })
    await replaceIssueDescription('关闭后需要恢复的内容')
    fireEvent.change(screen.getByTestId('workspace-issue-file-input'), {
      target: { files: [file] },
    })

    await waitFor(() =>
      expect(localStorage.getItem('wework-issue-composer-draft:backend:1:issue')).toContain(
        '未完成的 Issue'
      )
    )
    expect(screen.getByTestId('workspace-issue-draft-status')).toHaveTextContent('草稿已自动保存')
    await userEvent.click(screen.getByTestId('workspace-issue-close'))
    expect(onCancel).toHaveBeenCalledOnce()
    firstRender.unmount()

    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={vi.fn()}
      />
    )
    const restoredCompactInput = screen.getByTestId('workspace-issue-input')
    if (!(restoredCompactInput instanceof HTMLTextAreaElement)) {
      Object.defineProperty(restoredCompactInput, 'innerText', {
        configurable: true,
        value: '\n',
      })
    }
    await userEvent.click(screen.getByTestId('workspace-issue-expand'))

    expect(screen.getByTestId('workspace-issue-title')).toHaveValue('未完成的 Issue')
    expect(screen.getByTestId('workspace-issue-description')).toHaveTextContent(
      '关闭后需要恢复的内容'
    )
    expect(screen.getByRole('button', { name: 'draft.png' })).toBeInTheDocument()
  })

  it('clears the persisted draft after explicit discard or successful creation', async () => {
    const onCreate = vi.fn(async () => true)
    const firstRender = render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-issue-expand'))
    fireEvent.change(screen.getByTestId('workspace-issue-title'), {
      target: { value: '可清理草稿' },
    })
    await replaceIssueDescription('清理前的描述')
    await waitFor(() =>
      expect(localStorage.getItem('wework-issue-composer-draft:backend:1:issue')).not.toBeNull()
    )
    await userEvent.click(screen.getByTestId('workspace-issue-clear-draft'))
    expect(localStorage.getItem('wework-issue-composer-draft:backend:1:issue')).toBeNull()

    fireEvent.change(screen.getByTestId('workspace-issue-title'), {
      target: { value: '创建后清理' },
    })
    await replaceIssueDescription('提交内容')
    await userEvent.click(screen.getByTestId('workspace-issue-fullscreen-submit'))

    expect(onCreate).toHaveBeenCalledOnce()
    expect(localStorage.getItem('wework-issue-composer-draft:backend:1:issue')).toBeNull()
    firstRender.unmount()
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
})
