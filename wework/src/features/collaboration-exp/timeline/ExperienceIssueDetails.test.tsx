import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CollaborationAssignment, SharedWorkspaceApi } from '@wegent/collaboration'
import type { TodoEditorProps } from '@/features/todo/TodoEditor'
import '@/i18n'
import {
  experienceBindingFixture,
  experienceIssueFixture,
  experienceProjectFixture,
} from '../model/fixtures'
import type { ExperienceIssueData } from '../data/useExperienceIssue'
import { ExperienceIssueDetails } from './ExperienceIssueDetails'

const mock = vi.hoisted(() => ({ editor: vi.fn(), workbench: {} as Record<string, unknown> }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => mock.workbench }))
vi.mock('@/features/todo/TodoEditor', () => ({
  TodoEditor: (props: TodoEditorProps) => {
    mock.editor(props)
    return <div data-testid="production-issue-editor" />
  },
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setup(store: 'local' | 'backend' = 'backend') {
  const project = experienceProjectFixture({
    project_store: store,
    current_user_id: store === 'local' ? 0 : 7,
  })
  const issue = experienceIssueFixture()
  const related = experienceIssueFixture({ id: 'related', title: 'Related issue' })
  const list = vi
    .fn()
    .mockResolvedValue([
      issue,
      related,
      experienceIssueFixture({ id: 'hidden', title: 'Hidden issue', can_view_detail: false }),
      experienceIssueFixture({ id: 'foreign', cloud_project_id: 'foreign-project' }),
    ])
  const assignment: CollaborationAssignment = {
    id: 'current',
    issue_id: issue.id,
    target_type: 'human',
    target_id: '7',
    target_name: 'Member',
    body: '',
    comment_id: null,
    created_by_user_id: 7,
    created_by_user_name: 'Member',
    status: 'active',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-03T00:00:00Z',
  }
  const assignments = vi
    .fn()
    .mockResolvedValue([
      assignment,
      { ...assignment, id: 'old', updated_at: '2026-11-02T00:00:00Z' },
    ])
  const api = {
    issues: { list },
    assignments: { list: assignments },
  } as unknown as SharedWorkspaceApi
  const localClient = { source: 'local' }
  const cloudClient = { source: 'cloud' }
  const getRuntimeTranscript = vi.fn()
  mock.workbench = {
    state: { user: { id: 7 }, projects: [], devices: [], runtimeWork: null },
    services: {
      projectSpaceDetailServices: {
        local: { projectChatClient: localClient },
        cloud: { projectChatClient: cloudClient },
      },
      runtimeWorkApi: { getRuntimeTranscript },
    },
  }
  const data: ExperienceIssueData = {
    project,
    issue,
    taskBindings: [experienceBindingFixture({ taskUserId: store === 'local' ? 0 : 7 })],
  }
  const props = { api, data, active: true, revision: 0, onClose: vi.fn(), onChange: vi.fn() }
  return {
    props,
    list,
    assignments,
    assignment,
    related,
    localClient,
    cloudClient,
    getRuntimeTranscript,
  }
}

it('loads real project references and assignment state into the production native editor', async () => {
  const context = setup()
  const { props } = context
  const view = render(<ExperienceIssueDetails {...props} />)
  await view.findByTestId('production-issue-editor')
  expect(context.list).toHaveBeenCalledWith(props.data.project.id)
  expect(context.assignments).toHaveBeenCalledWith(props.data.issue.id)
  const editor = mock.editor.mock.lastCall?.[0] as TodoEditorProps
  expect(editor.sharedApi).toBe(props.api)
  expect(editor.allItems.map(item => item.id)).toEqual([props.data.issue.id, context.related.id])
  expect(editor.projectChatClient).toBe(context.cloudClient)
  expect(editor.getRuntimeTranscript).toBe(context.getRuntimeTranscript)
  expect(editor.currentAssignment).toEqual(context.assignment)
  expect(editor.currentUserId).toBe(7)
  expect(editor.initialTaskBindings?.[0]).toMatchObject({
    task_user_id: 7,
    device_id: 'device-1',
    task_id: 'task-1',
  })
  expect(editor).toMatchObject({
    mode: 'edit',
    readFirst: true,
    presentation: 'workspace-panel',
    selfManagedExecution: false,
  })
  if (editor.mode !== 'edit') throw new Error('Expected edit mode')
  editor.onUpdated({ ...editor.item, title: 'Saved title' })
  expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ title: 'Saved title' }))
  editor.onClose()
  expect(props.onClose).toHaveBeenCalledTimes(1)
  view.rerender(<ExperienceIssueDetails {...props} active={false} />)
  const inactive = mock.editor.mock.lastCall?.[0] as TodoEditorProps
  expect(inactive.projectChatClient).toBeUndefined()
  expect(view.getByTestId('production-issue-editor')).toBeTruthy()
})

it('keeps local project activity and owner identity on their original native services', async () => {
  const { props, localClient } = setup('local')
  const view = render(<ExperienceIssueDetails {...props} />)
  await view.findByTestId('production-issue-editor')
  const editor = mock.editor.mock.lastCall?.[0] as TodoEditorProps
  expect(editor.projectChatClient).toBe(localClient)
  expect(editor.currentUserId).toBe(0)
  expect(editor.selfManagedExecution).toBe(true)
  expect(editor.initialTaskBindings?.[0]).toMatchObject({
    task_user_id: 0,
    device_id: 'device-1',
    task_id: 'task-1',
  })
})

it('reports a failed reference read and retries without inventing an empty project', async () => {
  const { props, list } = setup()
  list.mockRejectedValueOnce(new Error('Project source unavailable'))
  const view = render(<ExperienceIssueDetails {...props} />)
  await view.findByRole('alert')
  expect(view.queryByTestId('production-issue-editor')).toBeNull()
  expect(mock.editor).not.toHaveBeenCalled()
  fireEvent.click(view.getByTestId('collaboration-exp-issue-details-retry'))
  await view.findByTestId('production-issue-editor')
  expect(list).toHaveBeenCalledTimes(2)
})

it('does not load inactive details and discards stale responses after changing Issues', async () => {
  const { props, list } = setup()
  const view = render(<ExperienceIssueDetails {...props} active={false} />)
  expect(list).not.toHaveBeenCalled()
  let finish: (value: unknown) => void = () => undefined
  list.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  view.rerender(<ExperienceIssueDetails {...props} />)
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
  const next = { ...props.data, issue: experienceIssueFixture({ id: 'next', title: 'Next issue' }) }
  list.mockResolvedValueOnce([next.issue])
  view.rerender(<ExperienceIssueDetails {...props} data={next} />)
  await view.findByTestId('production-issue-editor')
  await act(async () => finish([props.data.issue]))
  const editor = mock.editor.mock.lastCall?.[0] as TodoEditorProps
  expect(editor.mode === 'edit' && editor.item.id).toBe('next')
  expect(editor.allItems.map(item => item.id)).toEqual(['next'])
})

it('shows unavailable state when the native activity client is not ready', () => {
  const { props, list } = setup()
  mock.workbench = { ...mock.workbench, services: { projectSpaceDetailServices: {} } }
  const view = render(<ExperienceIssueDetails {...props} />)
  expect(view.getByRole('alert')).toBeTruthy()
  expect(view.queryByTestId('production-issue-editor')).toBeNull()
  expect(list).not.toHaveBeenCalled()
})
