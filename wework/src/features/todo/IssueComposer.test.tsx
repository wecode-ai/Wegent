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
  it('uses the first line as the title and remaining lines as the description', () => {
    expect(issueDraftFromText('完成发布验证\n覆盖创建和完成链路\n补充截图')).toEqual({
      title: '完成发布验证',
      description: '覆盖创建和完成链路\n补充截图',
    })
  })

  it('creates an issue in the selected board from one lightweight input', async () => {
    const onCreate = vi.fn()
    render(
      <IssueComposer
        boards={[
          { key: 'backend:1', name: '产品发布' },
          { key: 'local:2', name: '体验优化' },
        ]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    await userEvent.selectOptions(screen.getByTestId('workspace-issue-board'), 'local:2')
    await userEvent.type(screen.getByTestId('workspace-issue-input'), '修复工作空间创建入口')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}只创建 Issue')
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'local:2',
      title: '修复工作空间创建入口',
      description: '只创建 Issue',
      files: [],
      startExecution: false,
    })
  })

  it('supports the command-enter shortcut', async () => {
    const onCreate = vi.fn()
    render(
      <IssueComposer
        boards={[{ key: 'backend:1', name: '产品发布' }]}
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
      description: '',
      files: [],
      startExecution: false,
    })
  })

  it('can create an issue and start its first task immediately', async () => {
    const onCreate = vi.fn()
    render(
      <IssueComposer
        boards={[{ key: 'backend:1', name: '产品发布' }]}
        initialBoardKey="backend:1"
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    )

    await userEvent.type(screen.getByTestId('workspace-issue-input'), '完成发布验证')
    await userEvent.click(screen.getByTestId('workspace-issue-start-execution'))
    await userEvent.click(screen.getByTestId('workspace-issue-submit'))

    expect(onCreate).toHaveBeenCalledWith({
      boardKey: 'backend:1',
      title: '完成发布验证',
      description: '',
      files: [],
      startExecution: true,
    })
  })

  it('reuses the desktop task composer instead of a separate issue form', () => {
    render(
      <IssueComposer
        boards={[{ key: 'backend:1', name: '产品发布' }]}
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
        boards={[{ key: 'backend:1', name: '产品发布' }]}
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
      description: '',
      files: [file],
      startExecution: false,
    })
  })

  it('closes with Escape without showing a duplicate cancel action', () => {
    const onCancel = vi.fn()
    render(
      <IssueComposer
        boards={[{ key: 'backend:1', name: '产品发布' }]}
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
