import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import { PersonalIssuesView } from './PersonalIssuesView'
import type { PersonalHomeIssueDetailContext } from './WeworkPersonalHome'
import { IndependentIssuesContext } from './independentIssuesContext'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'

afterEach(cleanup)

it.each(['assigned', 'created', 'participating'] as const)(
  'opens %s Issues in place and navigates project headings separately',
  async scope => {
    const item = {
      id: 'issue',
      cloud_project_id: 'project',
      sequence_number: 1,
      title: 'List Issue',
      status: 'pending',
      assignee_user_id: 7,
      created_at: '2026-11-13T06:12:00Z',
      updated_at: '2026-11-13',
    } as WorkspaceMyWorkItem
    const projects = [
      { id: 'project', name: 'Project board', project_store: 'backend' },
    ] as CollaborationProject[]
    const sources = [
      {
        myWork: {
          page: vi.fn().mockResolvedValue({
            items: [item, { ...item, id: 'second', title: 'Second Issue' }],
            nextCursor: null,
          }),
        },
      },
    ] as unknown as SharedWorkspaceApi[]
    const onOpenIssue = vi.fn()
    const onOpenProject = vi.fn()
    const detail = vi.fn((context: PersonalHomeIssueDetailContext) => (
      <>
        <button onClick={() => context.onDetailExpandedChange?.(!context.detailExpanded)}>
          Expand detail
        </button>
        <button onClick={context.onClose}>Close drawer</button>
      </>
    ))
    render(
      <RuntimeTaskLifecycleProvider store={new RuntimeTaskLifecycleStore()}>
        <PersonalIssuesView
          scope={scope}
          sources={sources}
          projects={projects}
          userId={7}
          active
          onOpenIssue={onOpenIssue}
          onOpenProject={onOpenProject}
          renderIssueDetail={detail}
        />
      </RuntimeTaskLifecycleProvider>
    )
    fireEvent.click(await screen.findByTestId('personal-home-issue-issue'))
    expect(screen.getByTestId('personal-home-issue-issue').closest('article')).toHaveAttribute(
      'aria-current',
      'true'
    )
    expect(screen.getByTestId(`personal-issues-${scope}`)).toBeInTheDocument()
    expect(onOpenIssue).not.toHaveBeenCalled()
    expect(detail).toHaveBeenLastCalledWith(
      expect.objectContaining({ presentation: 'drawer', issue: item, project: projects[0] })
    )
    expect(
      screen.getByTestId('personal-home-issue-issue').closest('article')?.querySelector('time')
    ).toHaveAttribute('datetime', item.created_at)
    fireEvent.click(screen.getByText('Expand detail'))
    expect(screen.getByTestId('personal-issues-detail').className).toContain('75%')
    fireEvent.click(screen.getByTestId('personal-home-issue-second'))
    expect(detail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detailExpanded: true,
        issue: expect.objectContaining({ id: 'second' }),
      })
    )
    expect(screen.getByTestId('personal-issues-detail').className).toContain('75%')
    fireEvent.click(screen.getByText('Close drawer'))
    expect(screen.getByTestId('personal-home-issue-issue').closest('article')).not.toHaveAttribute(
      'aria-current'
    )
    expect(screen.queryByTestId('personal-issues-detail')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('personal-issues-project-project'))
    expect(onOpenProject).toHaveBeenCalledExactlyOnceWith(projects[0])
  }
)

it('keeps the independent archive filter in the toolbar and loads archived results', async () => {
  const list = vi.fn().mockResolvedValue({ items: [], next_cursor: null })
  const context = { api: { list } as never, userId: 7, revision: 0, create: vi.fn(), open: vi.fn() }
  render(
    <IndependentIssuesContext.Provider value={context}>
      <PersonalIssuesView
        scope="created"
        sources={[]}
        projects={[]}
        userId={7}
        active
        onOpenIssue={vi.fn()}
        onOpenProject={vi.fn()}
        renderIssueDetail={vi.fn()}
      />
    </IndependentIssuesContext.Provider>
  )
  const filter = screen.getByTestId('personal-issues-archived')
  expect(screen.getByTestId('personal-issues-toolbar')).toContainElement(filter)
  fireEvent.click(filter)
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith('created', false, undefined, true, 'attention')
  )
})
