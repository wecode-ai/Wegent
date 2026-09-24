import { createRef } from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { IssueHomeComposer, type IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { WeworkIssueHomeComposer } from './WeworkIssueHomeComposer'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(async () => ({})),
}))

const createProps = (): IssueHomeTaskComposerProps => ({
  ref: createRef(),
  value: '',
  onChange: vi.fn(),
  onSubmit: vi.fn(async () => true),
  disabled: false,
  placeholder: '描述工作',
  error: null,
  members: [],
  attachments: [],
  onFileSelect: vi.fn(),
  onRemoveAttachment: vi.fn(),
  projectLabel: '目标项目',
  projectId: 'p1',
  projects: [
    { id: 'p1', name: '项目一', project_store: 'local' },
    { id: 'p2', name: '项目二', project_store: 'backend', workspace_id: 'cloud-team' },
  ] as IssueHomeTaskComposerProps['projects'],
  onSelectProject: vi.fn(),
})

describe('Wework Issue home task composer', () => {
  test('renders the shared execution environment notice above the editor', () => {
    const props = createProps()
    props.environmentNotice = <div data-testid="environment-notice">环境提示</div>

    render(<WeworkIssueHomeComposer {...props} />)

    const notice = screen.getByTestId('environment-notice')
    const input = screen.getByTestId('collaboration-home-issue-content')
    expect(notice.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('distinguishes same-name local and cloud projects and retains the selected space', async () => {
    const props = createProps()
    props.projects = props.projects.map(project => ({ ...project, name: '同名项目' }))
    props.workspaces = [
      { id: 'cloud-team', name: '研发团队' },
    ] as IssueHomeTaskComposerProps['workspaces']
    const { rerender } = render(<WeworkIssueHomeComposer {...props} />)
    const trigger = screen.getByTestId('collaboration-issue-project-trigger')
    expect(trigger).toHaveTextContent('本地空间')
    await userEvent.click(trigger)
    expect(screen.getByTestId('collaboration-issue-project-p1')).toHaveTextContent('本地空间')
    expect(screen.getByTestId('collaboration-issue-project-p2')).toHaveTextContent(
      '云端空间 · 研发团队'
    )
    await userEvent.click(screen.getByTestId('collaboration-issue-project-p2'))
    expect(props.onSelectProject).toHaveBeenCalledWith('p2')
    rerender(<WeworkIssueHomeComposer {...props} projectId="p2" />)
    expect(trigger).toHaveTextContent('云端空间 · 研发团队')
    expect(trigger).toHaveAccessibleName('目标项目: 同名项目 · 云端空间 · 研发团队')
    await userEvent.click(trigger)
    expect(screen.getByTestId('collaboration-issue-project-p2')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('collaboration-issue-project-p1')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })
  test('shows the first live mention in the compact owner button and persists manual changes', async () => {
    const ref = createRef<import('@wegent/collaboration/composer').ComposerInputHandle>()
    const onSubmit = vi.fn(async () => true)
    render(
      <IssueHomeComposer
        ref={ref}
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        pending={false}
        members={[
          { id: 7, user_id: 7, user_name: '李明', email: null, role: 'Owner' },
          { id: 8, user_id: 8, user_name: '王芳', email: null, role: 'Owner' },
        ]}
        projects={createProps().projects}
        projectId="p1"
        onSelectProject={vi.fn()}
        translate={createCollaborationTranslator('zh-CN')}
        placeholder="描述工作"
        projectLabel="项目"
        memberLabel="成员"
        error={null}
        renderTaskComposer={props => <WeworkIssueHomeComposer {...props} />}
      />
    )
    const owner = screen.getByTestId('collaboration-issue-owner')
    expect(owner.tagName).toBe('BUTTON')
    expect(owner).not.toHaveTextContent('未分配')
    await userEvent.type(screen.getByTestId('collaboration-home-issue-content'), '@')
    await userEvent.click(await screen.findByTestId('collaboration-home-mention-member-8'))
    await waitFor(() => expect(owner).toHaveTextContent('王芳'))
    await act(async () =>
      ref.current!.setValue(
        '[$@王芳](wework-member://p1/8) 负责，[$@李明](wework-member://p1/7) 参与'
      )
    )
    await waitFor(() => expect(owner).toHaveTextContent('王芳'))
    await userEvent.click(owner)
    await userEvent.click(screen.getByTestId('collaboration-issue-owner-7'))
    expect(owner).toHaveTextContent('李明')
    await userEvent.click(screen.getByTestId('collaboration-home-create-issue'))
    expect(onSubmit).toHaveBeenCalledWith('@王芳 负责，@李明 参与', { kind: 'user', id: '7' }, [])
  })
  test('renders the approved centered home and keeps guides from submitting', async () => {
    const props = createProps()
    render(<WeworkIssueHomeComposer {...props} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('连接想法，推进协作')
    expect(screen.queryByText('标题会根据内容自动生成')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 }).parentElement).toHaveClass('text-center')
    expect(screen.queryByTestId('collaboration-issue-guidance-toggle')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('collaboration-issue-guide-human'))
    expect(screen.getByTestId('collaboration-home-issue-content')).toHaveTextContent('希望改进：')
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  test('opens separate member and Issue pickers from toolbar triggers', async () => {
    const props = createProps()
    props.members = [
      {
        id: 'm1',
        type: 'user',
        title: '林悦',
        metaLabel: '成员',
        reference: '[$@林悦](wework-member://p1/1)',
        testId: 'pick-member',
      },
      {
        id: 'i1',
        type: 'issue',
        title: '#24 登录流程优化',
        metaLabel: 'Issue',
        reference: '[$#24 登录流程优化](wework-issue://p1/i1)',
        testId: 'pick-issue',
      },
    ]
    render(<WeworkIssueHomeComposer {...props} />)
    await userEvent.click(screen.getByTestId('collaboration-issue-mention_member'))
    expect(await screen.findByTestId('pick-member')).toBeInTheDocument()
    expect(screen.queryByTestId('pick-issue')).not.toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    const memberChip = document.querySelector('[data-composer-reference-kind="member"]')!
    expect(memberChip.querySelector('.composer-mention-label')).toHaveTextContent(/^林悦$/)
    expect(memberChip.querySelector('path')).toHaveAttribute('d', 'M20 21v-2a7 7 0 0 0-14 0v2')
    await userEvent.click(screen.getByTestId('collaboration-issue-reference_issue'))
    expect(screen.getByTestId('collaboration-home-issue-content').textContent).toContain('#')
    expect(await screen.findByTestId('pick-issue')).toBeInTheDocument()
    expect(screen.queryByTestId('pick-member')).not.toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    const issueChip = document.querySelector('[data-composer-reference-kind="issue"]')!
    expect(issueChip.querySelector('.composer-mention-label')).toHaveTextContent(
      /^24 登录流程优化$/
    )
    expect(issueChip.querySelector('path')).toHaveAttribute(
      'd',
      'M4 9h16M3 15h16M10 3 8 21M16 3l-2 18'
    )
    await userEvent.click(screen.getByTestId('collaboration-home-create-issue'))
    expect(props.onSubmit).toHaveBeenCalledWith(expect.stringContaining('wework-issue://p1/i1'))
  })
  test('keeps the project selector inside the shared composer above its editor', async () => {
    const props = createProps()
    render(<WeworkIssueHomeComposer {...props} />)
    expect(screen.queryByTestId('desktop-empty-composer-frame')).not.toBeInTheDocument()
    expect(screen.getByTestId('collaboration-issue-workspace')).toBeInTheDocument()
    expect(screen.getByTestId('project-chat-composer')).toContainElement(
      screen.getByTestId('collaboration-home-issue-content')
    )
    expect(screen.getByTestId('project-chat-composer')).toHaveAttribute(
      'data-presentation',
      'document'
    )
    expect(screen.getByTestId('collaboration-home-issue-content')).toHaveClass('min-h-32')
    const projectTrigger = screen.getByTestId('collaboration-issue-project-trigger')
    expect(projectTrigger).toHaveTextContent('项目一')
    expect(screen.getByTestId('project-chat-composer')).toContainElement(projectTrigger)
    expect(
      projectTrigger.compareDocumentPosition(
        screen.getByTestId('collaboration-home-issue-content')
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByTestId('collaboration-home-create-issue')).toHaveTextContent('创建 Issue')
    await userEvent.click(projectTrigger)
    await userEvent.click(screen.getByTestId('collaboration-issue-project-p2'))
    expect(props.onSelectProject).toHaveBeenCalledWith('p2')
    expect(screen.queryByTestId('collaboration-issue-project-picker')).not.toBeInTheDocument()
  })

  test('submits the live draft and restores it after creation fails', async () => {
    const props = createProps()
    props.onSubmit = vi.fn(async () => false)
    render(<WeworkIssueHomeComposer {...props} />)
    const input = screen.getByTestId('collaboration-home-issue-content')
    // Exercise the same imperative draft handle used by task suggestions.
    await act(async () => {
      if ('current' in props.ref!) props.ref.current?.setValue('请整理发布计划')
    })
    await userEvent.click(screen.getByTestId('collaboration-home-create-issue'))
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith('请整理发布计划'))
    await waitFor(() => expect(input).toHaveTextContent('请整理发布计划'))
  })
})
