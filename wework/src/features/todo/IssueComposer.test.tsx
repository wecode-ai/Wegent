import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import type { RuntimeWorkListResponse } from '@/types/api'
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

const productProject = {
  ...workItemProject,
  id: 22,
  public_id: 'product-space',
  project_key: 'PRODUCT',
  name: '产品空间',
  project_store: 'backend' as const,
  task_provider: 'wegent' as const,
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
  it('derives a compact task-style title and preserves the complete content', () => {
    expect(issueDraftFromText('完成发布验证\n覆盖创建和完成链路\n补充截图')).toEqual({
      title: '完成发布验证 覆盖创建和完成链路 补充截图',
      description: '完成发布验证\n覆盖创建和完成链路\n补充截图',
    })
  })

  it('preserves a long issue title without truncation', () => {
    const description = '需要处理的任务'.repeat(20)

    expect(issueDraftFromText(description)).toEqual({
      title: description,
      description,
    })
  })

  it('creates a lightweight issue without requiring a local execution project', async () => {
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
    expect(screen.getByTestId('workspace-issue-heading')).toHaveTextContent('要推进什么？')
    expect(screen.getByText('描述目标、问题或交付，创建后会进入当前项目空间。')).toBeVisible()
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

    await userEvent.type(screen.getByTestId('workspace-issue-input'), '修复创建流程')
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
        runtimeProjectKey: 'remote:docs',
        runtimeProjectName: '文档',
        runtimeWorkspaceRoots: [],
        modelOptions: { collaborationMode: 'default' },
        modelSelection: null,
        additionalSkills: [],
      },
    })
  })

  it('selects the target project space from the compact composer', async () => {
    const onCreate = vi.fn()
    renderWithProjectChat(
      <IssueComposer
        projects={[workItemProject, productProject]}
        initialBoardKey="local:default-work-items"
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    await userEvent.selectOptions(
      screen.getByTestId('workspace-issue-project-compact'),
      'backend:22'
    )
    await userEvent.type(screen.getByTestId('workspace-issue-input'), '发布产品需求')
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:22',
      title: '发布产品需求',
      description: '发布产品需求',
      files: [],
      createTask: false,
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
    })
  })

  it('can open directly in task creation mode', async () => {
    const onCreate = vi.fn()
    renderWithProjectChat(
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
      taskRequest: {
        schemaVersion: 2,
        runtime: 'codex',
        message: '完成发布验证',
        modelOptions: { collaborationMode: 'default' },
        modelSelection: null,
        additionalSkills: [],
      },
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
    })
  })

  it('expands into an app-fullscreen form with separate issue fields', async () => {
    const onCreate = vi.fn()
    const file = new File(['image'], 'context.png', { type: 'image/png' })
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    await userEvent.type(screen.getByTestId('workspace-issue-input'), '自动生成的标题')
    await userEvent.click(screen.getByTestId('workspace-issue-expand'))

    expect(screen.getByTestId('workspace-issue-composer-panel')).toHaveClass(
      'fixed',
      'bottom-4',
      'left-4',
      'right-4',
      'top-[54px]',
      'w-auto',
      'rounded-2xl'
    )
    expect(screen.getByTestId('workspace-issue-composer-panel')).not.toHaveClass(
      'absolute',
      'inset-0',
      'top-4'
    )
    expect(screen.getByTestId('workspace-issue-title')).toHaveValue('自动生成的标题')
    expect(screen.getByTestId('workspace-issue-title')).toHaveClass(
      'text-heading-md',
      'font-medium'
    )
    expect(screen.getByTestId('workspace-issue-project')).toHaveValue('backend:1')
    await waitFor(() =>
      expect(screen.getByTestId('workspace-issue-description')).toHaveTextContent('自动生成的标题')
    )
    expect(screen.getByTestId('workspace-issue-description')).toHaveAttribute(
      'contenteditable',
      'true'
    )
    expect(screen.getByTestId('workspace-issue-description-region')).toHaveClass(
      'flex',
      'flex-1',
      'min-h-[360px]'
    )

    fireEvent.change(screen.getByTestId('workspace-issue-title'), {
      target: { value: '默认生成的标题' },
    })
    await replaceIssueDescription('完整 Issue 内容')
    fireEvent.change(screen.getByTestId('workspace-issue-file-input'), {
      target: { files: [file] },
    })
    await userEvent.click(screen.getByTestId('workspace-issue-collapse'))
    await userEvent.click(screen.getByTestId('workspace-issue-expand'))

    expect(screen.getByTestId('workspace-issue-title')).toHaveValue('默认生成的标题')
    expect(screen.getByTestId('workspace-issue-description')).toHaveTextContent('完整 Issue 内容')
    expect(screen.getByRole('button', { name: 'context.png' })).toBeInTheDocument()
    expect(
      screen.getByTestId('workspace-issue-composer-panel').querySelector('header')
    ).not.toHaveClass('border-b')
    expect(screen.getByTestId('workspace-issue-header-actions')).toHaveClass(
      'ml-auto',
      'flex',
      'gap-1'
    )
    expect(screen.getByTestId('workspace-issue-header-actions')).toContainElement(
      screen.getByTestId('workspace-issue-collapse')
    )
    expect(screen.getByTestId('workspace-issue-header-actions')).toContainElement(
      screen.getByTestId('workspace-issue-close')
    )
    expect(screen.getByTestId('workspace-issue-editor-body')).toHaveClass('w-full', 'px-6', 'py-4')
    expect(screen.getByTestId('workspace-issue-editor-body')).not.toHaveClass(
      'mx-auto',
      'max-w-[960px]'
    )
    expect(screen.getByTestId('workspace-issue-fullscreen-submit').closest('footer')).toHaveClass(
      'border-t'
    )

    await userEvent.click(screen.getByTestId('workspace-issue-fullscreen-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '默认生成的标题',
      description: '完整 Issue 内容',
      files: [file],
      createTask: false,
    })
  })

  it('does not run the dialog focus loop after the editor handles Tab', async () => {
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-issue-expand'))
    const editor = await screen.findByTestId('workspace-issue-description')
    editor.focus()
    editor.addEventListener('keydown', event => event.preventDefault(), { once: true })

    fireEvent.keyDown(editor, { key: 'Tab', code: 'Tab' })

    expect(document.activeElement).toBe(editor)
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

  it('stages files pasted or dropped into the fullscreen editor', async () => {
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-issue-expand'))
    const pastedFile = new File(['pasted'], 'pasted.txt', { type: 'text/plain' })
    fireEvent.paste(screen.getByTestId('workspace-issue-description'), {
      clipboardData: {
        files: [pastedFile],
        types: ['Files'],
      },
    })
    expect(screen.getByText('pasted.txt')).toBeInTheDocument()

    const droppedFile = new File(['dropped'], 'dropped.pdf', { type: 'application/pdf' })
    fireEvent.drop(screen.getByTestId('workspace-issue-editor-body'), {
      dataTransfer: {
        files: [droppedFile],
        types: ['Files'],
      },
    })
    expect(screen.getByText('dropped.pdf')).toBeInTheDocument()
  })

  it('keeps the fullscreen form open and resets it for continuous issue creation', async () => {
    const onCreate = vi.fn(async () => true)
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="local:default-work-items"
        projectMembers={{
          'local:default-work-items': [
            {
              id: 1,
              user_id: 7,
              user_name: 'Alice',
              email: 'alice@example.com',
              role: 'Maintainer',
            },
          ],
        }}
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-issue-expand'))
    await userEvent.type(screen.getByTestId('workspace-issue-title'), '第一个 Issue')
    await replaceIssueDescription('第一条描述')
    await userEvent.selectOptions(screen.getByTestId('workspace-issue-status'), 'in_progress')
    await userEvent.selectOptions(screen.getByTestId('workspace-issue-priority'), 'high')
    await userEvent.selectOptions(screen.getByTestId('workspace-issue-assignee'), '7')
    await userEvent.type(screen.getByTestId('workspace-issue-tag-input'), '体验{Enter}')
    await userEvent.click(screen.getByTestId('workspace-issue-continue-creating'))
    await userEvent.click(screen.getByTestId('workspace-issue-fullscreen-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'local:default-work-items',
      title: '第一个 Issue',
      description: '第一条描述',
      files: [],
      createTask: false,
      continueCreating: true,
      status: 'in_progress',
      priority: 'high',
      tags: ['体验'],
      assigneeUserId: 7,
    })
    expect(screen.getByTestId('workspace-issue-title')).toHaveValue('')
    expect(screen.getByTestId('workspace-issue-description')).toHaveTextContent('')
    expect(screen.getByTestId('workspace-issue-composer-panel')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('workspace-issue-title')).toHaveFocus())
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

  it('collapses fullscreen editing with Escape before closing the composer', async () => {
    const onCancel = vi.fn()
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        onCancel={onCancel}
        onCreate={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-issue-expand'))
    fireEvent.keyDown(screen.getByTestId('workspace-issue-description'), { key: 'Escape' })

    expect(screen.queryByTestId('workspace-issue-description')).not.toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
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

    expect(screen.getByRole('dialog', { name: '新建 Issue' })).toHaveAttribute('aria-modal', 'true')
    fireEvent.click(screen.getByTestId('workspace-issue-composer-panel'))
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('workspace-issue-composer'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('accepts typing immediately after opening a task composer popup', async () => {
    const user = userEvent.setup()
    render(
      <IssueComposer
        projects={[workItemProject]}
        initialBoardKey="backend:1"
        initialStartExecution
        presentation="popup"
        onCancel={vi.fn()}
        onCreate={vi.fn()}
      />
    )

    const input = screen.getByTestId('workspace-issue-input')
    await waitFor(() => expect(input).toHaveFocus())
    await user.keyboard('无需再次点击')

    expect(input).toHaveTextContent('无需再次点击')
  })
})
