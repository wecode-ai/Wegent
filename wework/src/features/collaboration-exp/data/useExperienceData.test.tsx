import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceMyWorkItem } from '@wegent/collaboration'
import type { ProjectChatClient } from '@wegent/chat-core'
import {
  experienceBindingFixture,
  experienceHumanRequestFixture,
  experienceIssueFixture,
  experienceProjectFixture,
} from '../model/fixtures'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import { selectTaskRows } from '../model'
import { useExperienceTasks } from './useExperienceTasks'
import { useExperienceIssue } from './useExperienceIssue'
import type { ExperienceSource } from './useExperienceSources'

afterEach(cleanup)

function sourceFixture(store: ExperienceSource['store'] = 'backend') {
  const project = experienceProjectFixture({ project_store: store, name: `${store} project` })
  const issue = experienceIssueFixture({ title: `${store} task` })
  const myWork = {
    ...issue,
    project_name: project.name,
    project_key: project.project_key,
    has_active_task: false,
    task_bindings: [
      experienceBindingFixture(),
      experienceBindingFixture({ id: 'another-binding' }),
    ],
  } satisfies WorkspaceMyWorkItem
  const api = {
    projects: {
      list: vi.fn().mockResolvedValue([project]),
      get: vi.fn().mockResolvedValue(project),
    },
    issues: { list: vi.fn().mockResolvedValue([issue]), get: vi.fn().mockResolvedValue(issue) },
    myWork: { page: vi.fn().mockResolvedValue({ items: [myWork], nextCursor: null }) },
    taskBindings: { list: vi.fn().mockResolvedValue([experienceBindingFixture()]) },
  }
  const source: ExperienceSource = { store, api: api as unknown as SharedWorkspaceApi }
  return { source, api, project, issue, myWork }
}

describe('source-owned experience requests', () => {
  it('hydrates default personal projects omitted from navigation once per project and preserves completed or unassigned human work', async () => {
    const { source, api, project, myWork } = sourceFixture()
    const personal = { ...project, id: DEFAULT_WORK_ITEM_PROJECT_ID }
    api.projects.list.mockResolvedValue([])
    api.projects.get.mockResolvedValue(personal)
    const completed = {
      ...myWork,
      cloud_project_id: personal.id,
      id: 'personal-completed',
      status: 'completed',
    }
    const human = {
      ...myWork,
      cloud_project_id: personal.id,
      id: 'personal-human',
      created_by_user_id: 8,
      assignee_user_id: null,
      human_requests: [
        experienceHumanRequestFixture({ project_id: personal.id, issue_id: 'personal-human' }),
      ],
    }
    api.myWork.page.mockResolvedValue({ items: [completed, human], nextCursor: null })
    api.issues.list.mockResolvedValue([])
    const sources = [source]
    const view = renderHook(
      ({ relevance }: { relevance: 'related' | 'all' }) =>
        useExperienceTasks(sources, [7], true, relevance),
      { initialProps: { relevance: 'related' } }
    )
    await waitFor(() => expect(view.result.current.loading).toBe(false))
    expect(api.projects.get.mock.calls).toEqual([[DEFAULT_WORK_ITEM_PROJECT_ID]])
    expect(
      selectTaskRows({ projects: view.result.current.projects, viewer: 7 }).map(row => row.id)
    ).toEqual(['personal-completed', 'personal-human'])
    expect(api.myWork.page).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 30, includeCompleted: true, scope: 'participating' })
    )
    view.rerender({ relevance: 'all' })
    await waitFor(() => expect(view.result.current.loading).toBe(false))
    expect(
      selectTaskRows(
        { projects: view.result.current.projects, viewer: 7 },
        { relevance: 'all' }
      ).map(row => row.id)
    ).toEqual(['personal-completed', 'personal-human'])
    expect(api.issues.list).toHaveBeenCalledWith(DEFAULT_WORK_ITEM_PROJECT_ID)
    expect(api.projects.get).toHaveBeenCalledTimes(1)
    expect(api.myWork.page).toHaveBeenCalledTimes(1)
  })

  it('loads omitted My work projects even when all visible is the initial mode', async () => {
    const { source, api, project } = sourceFixture()
    api.projects.list.mockResolvedValue([])
    const sources = [source]
    const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'all'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.projects.map(row => row.project.id)).toEqual([project.id])
    expect(
      selectTaskRows({ projects: result.current.projects, viewer: 7 }, { relevance: 'all' })
    ).toHaveLength(1)
    expect(api.myWork.page).toHaveBeenCalledTimes(1)
    expect(api.projects.get).toHaveBeenCalledTimes(1)
  })

  it('retains a failed hydration error on its exact source without probing another store, and recovers on explicit reload', async () => {
    const local = sourceFixture('local')
    const cloud = sourceFixture('backend')
    local.api.projects.list.mockResolvedValue([])
    local.api.projects.get.mockRejectedValue(new Error('Local project denied'))
    const sources = [local.source, cloud.source]
    const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
    await waitFor(() => expect(result.current.errors).toContain('Local project denied'))
    expect(
      selectTaskRows({ projects: result.current.projects, viewer: 7 }).map(row => row.project.store)
    ).toEqual(['backend'])
    expect(cloud.api.projects.get).not.toHaveBeenCalled()
    local.api.projects.get.mockResolvedValue(local.project)
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(
      selectTaskRows({ projects: result.current.projects, viewer: 7 }).map(row => row.project.store)
    ).toEqual(['local', 'backend'])
    expect(result.current.errors).toEqual([])
  })

  it('ignores a missing-project read that resolves after the account source was replaced', async () => {
    const old = sourceFixture()
    const next = sourceFixture()
    old.api.projects.list.mockResolvedValue([])
    next.api.projects.list.mockResolvedValue([])
    next.project.name = 'New account project'
    let finish!: (value: unknown) => void
    old.api.projects.get.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const view = renderHook(
      ({ sources }: { sources: ExperienceSource[] }) =>
        useExperienceTasks(sources, [7], true, 'related'),
      { initialProps: { sources: [old.source] } }
    )
    await waitFor(() => expect(old.api.projects.get).toHaveBeenCalledTimes(1))
    view.rerender({ sources: [next.source] })
    await waitFor(() =>
      expect(view.result.current.projects[0]?.project.name).toBe('New account project')
    )
    await act(async () => finish({ ...old.project, name: 'SECRET old account project' }))
    expect(JSON.stringify(view.result.current.projects)).not.toContain('SECRET')
  })

  it('proves direct sharing from manual collaborators only for bounded unproven My work candidates', async () => {
    const { source, api, myWork } = sourceFixture()
    const manual = { ...myWork, id: 'manual-share', created_by_user_id: 8, assignee_user_id: 8 }
    const automatic = { ...manual, id: 'automatic-task' }
    api.myWork.page.mockResolvedValue({ items: [myWork, manual, automatic], nextCursor: null })
    const collaborators = vi.fn(async (issueId: string) => [
      {
        id: `share-${issueId}`,
        issueId,
        userId: 7,
        userName: 'Member',
        email: null,
        source: issueId === 'manual-share' ? 'manual' : 'task',
        addedByUserId: 8,
        createdAt: '',
      },
    ])
    source.api.collaborators = { list: collaborators } as SharedWorkspaceApi['collaborators']
    const sources = [source]
    const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(
      selectTaskRows({ projects: result.current.projects, viewer: 7 }).map(row => row.id)
    ).toEqual(['EXP-1', 'manual-share'])
    expect(collaborators.mock.calls.map(args => args[0]).sort()).toEqual([
      'automatic-task',
      'manual-share',
    ])
    expect(api.issues.list).not.toHaveBeenCalled()
  })

  it('retries only failed task subscriptions and keeps healthy listeners across refresh events', async () => {
    const local = sourceFixture('local')
    const cloud = sourceFixture('backend')
    const localRelease = vi.fn()
    const cloudRelease = vi.fn()
    let notify!: () => void
    const healthy = vi.fn(async (listener: () => void) => {
      notify = listener
      return localRelease
    })
    const failed = vi
      .fn()
      .mockRejectedValueOnce(new Error('Subscription offline'))
      .mockResolvedValue(cloudRelease)
    local.source.api.activity = {
      subscribeLoopItemChanges: healthy,
    } as unknown as ProjectChatClient
    cloud.source.api.activity = { subscribeLoopItemChanges: failed } as unknown as ProjectChatClient
    const sources = [local.source, cloud.source]
    const view = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
    await waitFor(() => expect(view.result.current.subscriptionError).toBe(true))
    act(() => view.result.current.reload())
    await waitFor(() => expect(view.result.current.subscriptionError).toBe(false))
    expect(failed).toHaveBeenCalledTimes(2)
    expect(healthy).toHaveBeenCalledTimes(1)
    const reads = local.api.projects.list.mock.calls.length
    act(() => notify())
    await waitFor(() => expect(local.api.projects.list.mock.calls.length).toBeGreaterThan(reads))
    expect(failed).toHaveBeenCalledTimes(2)
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(localRelease).not.toHaveBeenCalled()
    view.unmount()
    expect(localRelease).toHaveBeenCalledTimes(1)
    expect(cloudRelease).toHaveBeenCalledTimes(1)
  })

  it('does not load catalogs, work or object details while inactive', async () => {
    const { source, api } = sourceFixture()
    const sources = [source]
    const { result } = renderHook(() => useExperienceTasks(sources, [7], false, 'related'))
    renderHook(() => useExperienceIssue(source, 'project-1', 'EXP-1', false, 0))
    await act(async () => {})
    expect(result.current.projects).toEqual([])
    expect(api.projects.list).not.toHaveBeenCalled()
    expect(api.myWork.page).not.toHaveBeenCalled()
    expect(api.issues.get).not.toHaveBeenCalled()
    expect(api.taskBindings.list).not.toHaveBeenCalled()
  })

  it('reuses paged My work for related tasks and keeps all bindings on one Issue', async () => {
    const { source, api } = sourceFixture()
    const sources = [source]
    const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const rows = selectTaskRows({ projects: result.current.projects, viewer: 7 })
    expect(rows).toHaveLength(1)
    expect(rows[0].conversations.items[0].bindingIds).toEqual(['binding-1', 'another-binding'])
    expect(api.myWork.page).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'participating', includeCompleted: true })
    )
    expect(api.issues.list).not.toHaveBeenCalled()
  })

  it('keeps equal local/cloud IDs separate and never substitutes a failed source', async () => {
    const local = sourceFixture('local')
    const cloud = sourceFixture('backend')
    const sources = [local.source, cloud.source]
    cloud.api.issues.list.mockRejectedValue(new Error('cloud offline'))
    const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'all'))
    await waitFor(() => expect(result.current.errors).toContain('cloud offline'))
    expect(
      selectTaskRows({ projects: result.current.projects, viewer: 7 }, { relevance: 'all' }).map(
        row => row.title
      )
    ).toEqual(['local task', 'backend task'])
    expect(local.api.issues.list).toHaveBeenCalledWith(local.project.id)
    expect(cloud.api.issues.list).toHaveBeenCalledWith(cloud.project.id)
    expect(local.api.myWork.page).toHaveBeenCalledWith(
      expect.objectContaining({ includeCompleted: true, limit: 30 })
    )
    cloud.api.issues.list.mockResolvedValue([cloud.issue])
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const rows = selectTaskRows(
      { projects: result.current.projects, viewer: 7 },
      { relevance: 'all' }
    )
    expect(rows.map(row => row.title)).toEqual(['local task', 'backend task'])
    expect(new Set(rows.map(row => row.key)).size).toBe(2)
  })

  it('ignores an old account catalog that resolves after a source replacement', async () => {
    const old = sourceFixture()
    const next = sourceFixture()
    next.project.name = 'Next account'
    let finish!: (projects: unknown) => void
    old.api.projects.list.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const firstSources = [old.source]
    const nextSources = [next.source]
    const { result, rerender } = renderHook(
      ({ sources }) => useExperienceTasks(sources, [7], true, 'all'),
      { initialProps: { sources: firstSources } }
    )
    rerender({ sources: nextSources })
    await waitFor(() => expect(result.current.projects[0]?.project.name).toBe('Next account'))
    await act(async () => finish([old.project]))
    expect(result.current.projects[0]?.project.name).toBe('Next account')
    expect(old.api.issues.list).not.toHaveBeenCalled()
  })

  it('does not read private bindings for a hidden or mismatched Issue', async () => {
    const { source, api, issue } = sourceFixture()
    api.issues.get.mockResolvedValue({ ...issue, can_view_detail: false })
    const { result, rerender } = renderHook(
      ({ revision }) => useExperienceIssue(source, 'project-1', 'EXP-1', true, revision),
      { initialProps: { revision: 0 } }
    )
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.data).toBeNull()
    expect(api.taskBindings.list).not.toHaveBeenCalled()
    api.issues.get.mockResolvedValue({ ...issue, cloud_project_id: 'unrelated' })
    rerender({ revision: 1 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toBeNull()
    expect(api.taskBindings.list).not.toHaveBeenCalled()
  })

  it('does not let an old task response replace the newly selected task', async () => {
    const { source, api, issue } = sourceFixture()
    let finish!: (value: unknown) => void
    api.issues.get.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    api.issues.get.mockResolvedValue({ ...issue, id: 'EXP-2', title: 'New selection' })
    const { result, rerender } = renderHook(
      ({ id }) => useExperienceIssue(source, 'project-1', id, true, 0),
      { initialProps: { id: 'EXP-1' } }
    )
    rerender({ id: 'EXP-2' })
    await waitFor(() => expect(result.current.data?.issue.title).toBe('New selection'))
    await act(async () => finish(issue))
    expect(result.current.data?.issue.id).toBe('EXP-2')
    expect(api.taskBindings.list).toHaveBeenCalledTimes(1)
    expect(api.taskBindings.list).toHaveBeenCalledWith('EXP-2', 'project-1')
  })
})
