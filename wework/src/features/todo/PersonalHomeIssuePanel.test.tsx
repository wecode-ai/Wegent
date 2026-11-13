import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  CollaborationIssue,
  CollaborationIssueDetailRenderContext,
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import i18n from '@/i18n'
import { PersonalHomeIssuePanel } from './PersonalHomeIssuePanel'

afterEach(cleanup)
async function setup(
  get = vi
    .fn()
    .mockResolvedValue({ id: 'one', cloud_project_id: 'p1', title: 'Authoritative', version: 3 })
) {
  await i18n.changeLanguage('en')
  const renderDetail = vi.fn((context: CollaborationIssueDetailRenderContext) => (
    <>
      <button onClick={() => context.onChange({ ...context.issue, title: 'Saved title' })}>
        Actual board editor
      </button>
      <button onClick={context.onCreateTask}>Create task</button>
    </>
  ))
  const api = {
    issues: { get, list: vi.fn().mockResolvedValue([]) },
    assignments: { list: vi.fn().mockResolvedValue([]) },
    taskBindings: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as SharedWorkspaceApi
  const props = {
    api,
    renderDetail,
    project: { id: 'p1', project_store: 'backend' } as CollaborationProject,
    issue: {
      id: 'one',
      cloud_project_id: 'p1',
      title: 'Summary',
      project_key: 'KEY',
    } as WorkspaceMyWorkItem,
    active: true,
    refreshKey: 0,
    onUpdated: vi.fn(),
    onOpenIssue: vi.fn(),
    onClose: vi.fn(),
    onCreateTask: vi.fn(),
  }
  return { ...render(<PersonalHomeIssuePanel {...props} />), props, get, renderDetail }
}
it('loads the authorized detail and gives the board renderer its real task creation callback', async () => {
  const { props, get, renderDetail } = await setup()
  await screen.findByText('Actual board editor')
  expect(get).toHaveBeenCalledExactlyOnceWith('one')
  expect(renderDetail).toHaveBeenLastCalledWith(
    expect.objectContaining({
      issue: expect.objectContaining({ title: 'Authoritative', version: 3 }),
      onCreateTask: expect.any(Function),
    })
  )
  fireEvent.click(screen.getByText('Create task'))
  expect(props.onCreateTask).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'one', version: 3 })
  )
  fireEvent.click(screen.getByText('Actual board editor'))
  expect(props.onUpdated).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Saved title', project_key: 'KEY', version: 3 })
  )
})
it('keeps failures local and retries without displaying a stale summary', async () => {
  const get = vi
    .fn()
    .mockRejectedValueOnce(new Error('403'))
    .mockResolvedValue({ id: 'one', cloud_project_id: 'p1', version: 1 })
  const { renderDetail } = await setup(get)
  await screen.findByRole('alert')
  expect(renderDetail).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('personal-home-detail-retry'))
  await screen.findByText('Actual board editor')
})

it('publishes confirmed read state to the list as well as the open detail', async () => {
  const { props, renderDetail } = await setup()
  await screen.findByText('Actual board editor')
  const context = renderDetail.mock.lastCall![0]
  act(() => context.onRead({ ...context.issue, is_unread: false, activity_read_sequence: 12 }))
  expect(props.onUpdated).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'one', is_unread: false, activity_read_sequence: 12 })
  )
  expect(renderDetail.mock.lastCall![0].issue.activity_read_sequence).toBe(12)
})

it('retains a read confirmation while an earlier refresh finishes loading task bindings', async () => {
  const { props, rerender, renderDetail } = await setup()
  await screen.findByText('Actual board editor')
  let finish!: (value: never[]) => void
  vi.mocked(props.api.taskBindings!.list).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  rerender(<PersonalHomeIssuePanel {...props} refreshKey={1} />)
  await act(async () => {})
  const context = renderDetail.mock.lastCall![0]
  act(() => context.onRead({ ...context.issue, is_unread: false, activity_read_sequence: 12 }))
  const bindings = [{ id: 'new-binding' }] as never[]
  await act(async () => finish(bindings))
  expect(renderDetail.mock.lastCall![0].issue.activity_read_sequence).toBe(12)
  expect(renderDetail.mock.lastCall![0].taskBindings).toEqual(bindings)
  expect(props.onUpdated).toHaveBeenLastCalledWith(
    expect.objectContaining({ activity_read_sequence: 12 })
  )
})

it('preserves a newer saved Issue when an earlier read confirmation arrives', async () => {
  const { props, renderDetail } = await setup()
  await screen.findByText('Actual board editor')
  const earlier = renderDetail.mock.lastCall![0]
  act(() => earlier.onChange({ ...earlier.issue, title: 'New edit', version: 4 }))
  act(() => earlier.onRead({ ...earlier.issue, is_unread: false, activity_read_sequence: 12 }))
  expect(renderDetail.mock.lastCall![0].issue).toEqual(
    expect.objectContaining({ title: 'New edit', version: 4, activity_read_sequence: 12 })
  )
  expect(props.onUpdated).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: 'New edit', version: 4 })
  )
})
it('rejects late responses from a previous API scope', async () => {
  let resolveOld!: (item: CollaborationIssue) => void
  const { props, rerender, renderDetail } = await setup(
    vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          resolveOld = resolve
        })
    )
  )
  const api = {
    ...props.api,
    issues: {
      ...props.api.issues,
      get: vi
        .fn()
        .mockResolvedValue({ id: 'one', cloud_project_id: 'p1', title: 'New scope', version: 2 }),
    },
  }
  rerender(<PersonalHomeIssuePanel {...props} api={api} />)
  await screen.findByText('Actual board editor')
  await act(async () =>
    resolveOld({ id: 'one', cloud_project_id: 'p1', title: 'Old scope' } as CollaborationIssue)
  )
  expect(renderDetail).toHaveBeenLastCalledWith(
    expect.objectContaining({ issue: expect.objectContaining({ title: 'New scope' }) })
  )
})

it('does not overwrite a saved edit with a refresh that started before the save', async () => {
  const { get, props, rerender, renderDetail } = await setup()
  await screen.findByText('Actual board editor')
  let resolve!: (item: CollaborationIssue) => void
  get.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  rerender(<PersonalHomeIssuePanel {...props} refreshKey={1} />)
  fireEvent.click(screen.getByText('Actual board editor'))
  await act(async () =>
    resolve({ id: 'one', cloud_project_id: 'p1', title: 'Stale', version: 3 } as CollaborationIssue)
  )
  expect(renderDetail).toHaveBeenLastCalledWith(
    expect.objectContaining({ issue: expect.objectContaining({ title: 'Saved title' }) })
  )
  expect(props.onUpdated).not.toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Stale' }))
})

it('keeps the authorized detail mounted when its same-scope refresh fails', async () => {
  const { get, props, rerender, renderDetail } = await setup()
  const editor = await screen.findByText('Actual board editor')
  get.mockRejectedValueOnce(new Error('offline'))
  rerender(<PersonalHomeIssuePanel {...props} refreshKey={1} />)
  await screen.findByRole('alert')
  expect(screen.getByText('Actual board editor')).toBe(editor)
  expect(renderDetail).toHaveBeenLastCalledWith(
    expect.objectContaining({ issue: expect.objectContaining({ title: 'Authoritative' }) })
  )
  fireEvent.click(screen.getByTestId('personal-home-detail-retry'))
  await act(async () => {})
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('opens a related Issue without inheriting the current assignment or task summaries', async () => {
  const { props, rerender, renderDetail } = await setup()
  const issue = {
    ...props.issue,
    task_bindings: [],
    assignment_context: { body: 'For A', created_by_user_name: 'Alice', created_at: '2026-11-13' },
  }
  rerender(<PersonalHomeIssuePanel {...props} issue={issue} />)
  await screen.findByText('Actual board editor')
  const context = renderDetail.mock.lastCall![0]
  context.onOpenRelatedIssue!({ ...context.issue, id: 'two', title: 'Related' })
  expect(props.onOpenIssue).toHaveBeenCalledWith(expect.objectContaining({ id: 'two' }))
  expect(props.onOpenIssue.mock.lastCall![0]).not.toHaveProperty('assignment_context')
  expect(props.onOpenIssue.mock.lastCall![0]).not.toHaveProperty('task_bindings')
})
