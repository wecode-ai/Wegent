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
import {
  forgetProjectSpaceTaskBinding,
  projectSpaceForRuntimeTask,
  publishProjectSpaceTaskBindingChanged,
  rememberProjectSpaceTaskBinding,
} from '@/features/todo/projectSpaceSelection'

const registeredTasks = [{ deviceId: 'device-1', taskId: 'task-1' }]

afterEach(() => {
  cleanup()
  for (const task of registeredTasks) {
    const project = projectSpaceForRuntimeTask(task)
    if (project) forgetProjectSpaceTaskBinding(task, project)
  }
  registeredTasks.splice(1)
})

function bindingTask(taskId: string) {
  const task = { deviceId: 'experience-binding-test', taskId }
  registeredTasks.push(task)
  return task
}

function boundWork(
  base: WorkspaceMyWorkItem,
  task: { deviceId: string; taskId: string },
  overrides: Partial<WorkspaceMyWorkItem> = {}
): WorkspaceMyWorkItem & { task_bindings: NonNullable<WorkspaceMyWorkItem['task_bindings']> } {
  const issue = { ...base, ...overrides }
  return {
    ...issue,
    task_bindings: [
      experienceBindingFixture({
        id: task.taskId,
        projectId: issue.cloud_project_id,
        issueId: issue.id,
        ...task,
      }),
    ],
  }
}

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
  const source: ExperienceSource = {
    store,
    api: api as unknown as SharedWorkspaceApi,
    participationViewer: store === 'local' ? [0, 7] : 7,
  }
  return { source, api, project, issue, myWork }
}

describe('verified experimental task binding registration', () => {
  it.each(['local', 'backend'] as const)(
    'registers %s pages incrementally without deleting other project bindings',
    async store => {
      const { source, api, project, myWork } = sourceFixture(store)
      const first = bindingTask(`${store}-first`)
      const second = bindingTask(`${store}-second`)
      const other = bindingTask(`${store}-already-known`)
      const ref = { projectStore: store, projectId: project.id }
      rememberProjectSpaceTaskBinding(other, ref)
      api.myWork.page
        .mockResolvedValueOnce({ items: [boundWork(myWork, first)], nextCursor: 'second' })
        .mockResolvedValueOnce({
          items: [boundWork(myWork, second, { id: 'EXP-2' })],
          nextCursor: null,
        })
      const sources = [source]
      const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(projectSpaceForRuntimeTask(first)).toEqual(ref)
      await act(() => result.current.loadMore())
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(projectSpaceForRuntimeTask(second)).toEqual(ref)
      expect(projectSpaceForRuntimeTask(first)).toEqual(ref)
      expect(projectSpaceForRuntimeTask(other)).toEqual(ref)
    }
  )

  it('keeps identical project and Issue IDs isolated by their actual local and backend sources', async () => {
    const local = sourceFixture('local')
    const cloud = sourceFixture('backend')
    const localTask = bindingTask('same-id-local')
    const cloudTask = bindingTask('same-id-cloud')
    const unknown = bindingTask('unknown')
    local.api.myWork.page.mockResolvedValue({
      items: [boundWork(local.myWork, localTask)],
      nextCursor: null,
    })
    cloud.api.myWork.page.mockResolvedValue({
      items: [boundWork(cloud.myWork, cloudTask)],
      nextCursor: null,
    })
    const sources = [local.source, cloud.source]
    const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(projectSpaceForRuntimeTask(localTask)).toEqual({
      projectStore: 'local',
      projectId: local.project.id,
    })
    expect(projectSpaceForRuntimeTask(cloudTask)).toEqual({
      projectStore: 'backend',
      projectId: cloud.project.id,
    })
    expect(projectSpaceForRuntimeTask(unknown)).toBeUndefined()
  })

  it.each([
    'hidden',
    'binding-project',
    'binding-issue',
    'project-store',
    'unknown-project',
    'no-bindings',
    'empty-device',
    'empty-task',
  ] as const)('does not register an unproven %s binding', async invalid => {
    const { source, api, project, myWork } = sourceFixture('local')
    const task = bindingTask(`unproven-${invalid}`)
    const work = boundWork(myWork, task)
    if (invalid === 'hidden') work.can_view_detail = false
    if (invalid === 'binding-project') work.task_bindings[0].projectId = 'different-project'
    if (invalid === 'binding-issue') work.task_bindings[0].issueId = 'different-issue'
    if (invalid === 'empty-device') work.task_bindings[0].deviceId = ''
    if (invalid === 'empty-task') work.task_bindings[0].taskId = ''
    if (invalid === 'project-store')
      api.projects.list.mockResolvedValue([{ ...project, project_store: 'backend' }])
    if (invalid === 'unknown-project') {
      work.cloud_project_id = 'unknown-project'
      work.task_bindings[0].projectId = 'unknown-project'
      api.projects.get.mockRejectedValue(new Error('Project is unavailable'))
    }
    api.myWork.page.mockResolvedValue({
      items: [invalid === 'no-bindings' ? { ...work, task_bindings: undefined } : work],
      nextCursor: null,
    })
    const sources = [source]
    const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(projectSpaceForRuntimeTask(task)).toBeUndefined()
  })

  it.each(['moved', 'unbound'] as const)(
    'does not replay retained or failed rows after the task is %s',
    async change => {
      const { source, api, myWork } = sourceFixture('local')
      const task = bindingTask(`changed-${change}`)
      api.myWork.page.mockResolvedValue({ items: [boundWork(myWork, task)], nextCursor: null })
      const sources = [source]
      const view = renderHook(
        ({ relevance }: { relevance: 'related' | 'all' }) =>
          useExperienceTasks(sources, [7], true, relevance),
        { initialProps: { relevance: 'related' } }
      )
      await waitFor(() => expect(view.result.current.loading).toBe(false))
      expect(projectSpaceForRuntimeTask(task)).toEqual({
        projectStore: 'local',
        projectId: 'project-1',
      })
      const newer = { projectStore: 'backend' as const, projectId: 'newer-project' }
      if (change === 'moved') rememberProjectSpaceTaskBinding(task, newer)
      else forgetProjectSpaceTaskBinding(task, projectSpaceForRuntimeTask(task)!)
      view.rerender({ relevance: 'all' })
      await waitFor(() => expect(view.result.current.loading).toBe(false))
      expect(projectSpaceForRuntimeTask(task)).toEqual(change === 'moved' ? newer : undefined)
      api.myWork.page.mockRejectedValueOnce(new Error('Current source unavailable'))
      act(() => view.result.current.reload())
      await waitFor(() => expect(view.result.current.relatedError).toBe(true))
      expect(projectSpaceForRuntimeTask(task)).toEqual(change === 'moved' ? newer : undefined)
    }
  )

  it.each([true, false])(
    'prefers a proven user project over the default container (default first: %s)',
    async defaultFirst => {
      const { source, api, project, myWork } = sourceFixture('local')
      const task = bindingTask(`default-order-${defaultFirst}`)
      const personal = { ...project, id: DEFAULT_WORK_ITEM_PROJECT_ID, project_key: 'WORK' }
      api.projects.list.mockResolvedValue([personal, project])
      const work = boundWork(myWork, task)
      const personalWork = boundWork(myWork, task, {
        id: 'personal-issue',
        cloud_project_id: personal.id,
      })
      api.myWork.page.mockResolvedValue({
        items: defaultFirst ? [personalWork, work] : [work, personalWork],
        nextCursor: null,
      })
      const sources = [source]
      const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(projectSpaceForRuntimeTask(task)).toEqual({
        projectStore: 'local',
        projectId: project.id,
      })
    }
  )

  it('ignores a late My work response after the account source is replaced', async () => {
    const old = sourceFixture('local')
    const next = sourceFixture('backend')
    const task = bindingTask('account-replacement')
    let finish!: (page: { items: WorkspaceMyWorkItem[]; nextCursor: null }) => void
    old.api.myWork.page.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    next.api.myWork.page.mockResolvedValue({
      items: [boundWork(next.myWork, task)],
      nextCursor: null,
    })
    const view = renderHook(
      ({ sources }: { sources: ExperienceSource[] }) =>
        useExperienceTasks(sources, [7], true, 'related'),
      { initialProps: { sources: [old.source] } }
    )
    await waitFor(() => expect(old.api.myWork.page).toHaveBeenCalledOnce())
    view.rerender({ sources: [next.source] })
    await waitFor(() => expect(view.result.current.loading).toBe(false))
    expect(projectSpaceForRuntimeTask(task)).toEqual({
      projectStore: 'backend',
      projectId: next.project.id,
    })
    await act(async () => finish({ items: [boundWork(old.myWork, task)], nextCursor: null }))
    expect(projectSpaceForRuntimeTask(task)).toEqual({
      projectStore: 'backend',
      projectId: next.project.id,
    })
  })

  it.each(['both-user', 'default-first', 'user-first'] as const)(
    'keeps cross-source duplicate ownership stable: %s',
    async order => {
      const local = sourceFixture('local')
      const cloud = sourceFixture('backend')
      const task = bindingTask(`cross-source-${order}`)
      const localProject =
        order === 'default-first'
          ? { ...local.project, id: DEFAULT_WORK_ITEM_PROJECT_ID, project_key: 'WORK' }
          : local.project
      const cloudProject =
        order === 'user-first'
          ? { ...cloud.project, id: DEFAULT_WORK_ITEM_PROJECT_ID, project_key: 'WORK' }
          : cloud.project
      local.api.projects.list.mockResolvedValue([localProject])
      cloud.api.projects.list.mockResolvedValue([cloudProject])
      local.api.myWork.page.mockResolvedValue({
        items: [boundWork(local.myWork, task, { cloud_project_id: localProject.id })],
        nextCursor: null,
      })
      let finishCloud!: (page: { items: WorkspaceMyWorkItem[]; nextCursor: null }) => void
      cloud.api.myWork.page.mockImplementation(
        () =>
          new Promise(resolve => {
            finishCloud = resolve
          })
      )
      const sources = [local.source, cloud.source]
      const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
      await waitFor(() =>
        expect(projectSpaceForRuntimeTask(task)).toEqual({
          projectStore: 'local',
          projectId: localProject.id,
        })
      )
      await act(async () =>
        finishCloud({
          items: [boundWork(cloud.myWork, task, { cloud_project_id: cloudProject.id })],
          nextCursor: null,
        })
      )
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(projectSpaceForRuntimeTask(task)).toEqual(
        order === 'default-first'
          ? { projectStore: 'backend', projectId: cloudProject.id }
          : { projectStore: 'local', projectId: localProject.id }
      )
    }
  )

  it.each(['bound', 'unbound'] as const)(
    'rejects an old response batched after a %s event and accepts the next successful read',
    async type => {
      const { source, api, project, myWork } = sourceFixture('local')
      const task = bindingTask(`batched-event-${type}`)
      const oldRef = { projectStore: 'local' as const, projectId: project.id }
      const movedRef = { projectStore: 'backend' as const, projectId: 'moved-project' }
      rememberProjectSpaceTaskBinding(task, oldRef)
      let finishOld!: (page: { items: WorkspaceMyWorkItem[]; nextCursor: null }) => void
      let finishFresh!: (page: { items: WorkspaceMyWorkItem[]; nextCursor: null }) => void
      api.myWork.page
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finishOld = resolve
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finishFresh = resolve
            })
        )
      const sources = [source]
      const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
      await waitFor(() => expect(api.myWork.page).toHaveBeenCalledOnce())
      const oldWork = boundWork(myWork, task)
      await act(async () => {
        publishProjectSpaceTaskBindingChanged({
          type,
          task,
          project: type === 'bound' ? movedRef : oldRef,
        })
        finishOld({ items: [oldWork], nextCursor: null })
        await Promise.resolve()
      })
      await waitFor(() => expect(api.myWork.page).toHaveBeenCalledTimes(2))
      expect(projectSpaceForRuntimeTask(task)).toEqual(type === 'bound' ? movedRef : undefined)
      expect(result.current.loading).toBe(true)
      await act(async () => finishFresh({ items: [oldWork], nextCursor: null }))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(projectSpaceForRuntimeTask(task)).toEqual(oldRef)
    }
  )

  it('does not register a response that completes after the experience is inactive', async () => {
    const { source, api, myWork } = sourceFixture('local')
    const task = bindingTask('inactive-read')
    let finish!: (page: { items: WorkspaceMyWorkItem[]; nextCursor: null }) => void
    api.myWork.page.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const sources = [source]
    const view = renderHook(({ active }) => useExperienceTasks(sources, [7], active, 'related'), {
      initialProps: { active: true },
    })
    await waitFor(() => expect(api.myWork.page).toHaveBeenCalledOnce())
    view.rerender({ active: false })
    await act(async () => finish({ items: [boundWork(myWork, task)], nextCursor: null }))
    expect(projectSpaceForRuntimeTask(task)).toBeUndefined()
  })

  it.each(['bound', 'unbound'] as const)(
    'rejects an in-flight old page after a batched %s event without deleting other associations',
    async type => {
      const { source, api, myWork } = sourceFixture('local')
      const task = bindingTask(`old-page-${type}`)
      const oldRef = { projectStore: 'local' as const, projectId: 'project-1' }
      const movedRef = { projectStore: 'backend' as const, projectId: 'newer-project' }
      let finishPage!: (page: { items: WorkspaceMyWorkItem[]; nextCursor: null }) => void
      let finishRefresh!: (page: { items: WorkspaceMyWorkItem[]; nextCursor: null }) => void
      api.myWork.page
        .mockResolvedValueOnce({ items: [boundWork(myWork, task)], nextCursor: 'old-page' })
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finishPage = resolve
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finishRefresh = resolve
            })
        )
      const sources = [source]
      const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'related'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(projectSpaceForRuntimeTask(task)).toEqual(oldRef)
      let page!: Promise<void>
      act(() => {
        page = result.current.loadMore()
      })
      await waitFor(() => expect(api.myWork.page).toHaveBeenCalledTimes(2))
      await act(async () => {
        publishProjectSpaceTaskBindingChanged({
          type,
          task,
          project: type === 'bound' ? movedRef : oldRef,
        })
        finishPage({
          items: [boundWork(myWork, task, { id: 'unseen-old-page-issue' })],
          nextCursor: null,
        })
        await page
      })
      await waitFor(() => expect(api.myWork.page).toHaveBeenCalledTimes(3))
      expect(projectSpaceForRuntimeTask(task)).toEqual(type === 'bound' ? movedRef : undefined)
      await act(async () => finishRefresh({ items: [], nextCursor: null }))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(projectSpaceForRuntimeTask(task)).toEqual(type === 'bound' ? movedRef : undefined)
    }
  )
})

describe('source-owned experience requests', () => {
  it('carries authoritative local readers through related rows and direct Issue detail', async () => {
    const { source, api, myWork } = sourceFixture('local')
    const nativeBinding = experienceBindingFixture({ taskUserId: 0 })
    api.myWork.page.mockResolvedValue({
      items: [{ ...myWork, assignee_user_id: 0, task_bindings: [nativeBinding] }],
      nextCursor: null,
    })
    api.taskBindings.list.mockResolvedValue([nativeBinding])
    const sources = [source]
    const { result } = renderHook(() => ({
      tasks: useExperienceTasks(sources, [7], true, 'related'),
      detail: useExperienceIssue(source, 'project-1', 'EXP-1', true, 0),
    }))
    await waitFor(() => expect(result.current.tasks.loading).toBe(false))
    await waitFor(() => expect(result.current.detail.data).not.toBeNull())
    expect(result.current.tasks.projects[0].participationViewer).toEqual([0, 7])
    expect(result.current.detail.data?.participationViewer).toEqual([0, 7])
    const rows = selectTaskRows({ projects: result.current.tasks.projects, viewer: 7 })
    expect(rows).toHaveLength(1)
    expect(rows[0].conversations.items[0].ownerUserId).toBe(0)
    expect(result.current.tasks.errors).toEqual([])
  })

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

  it.each(['local', 'backend'] as const)(
    'continues bounded %s discovery in all mode and retains known tasks across a failed next page',
    async store => {
      const { source, api, project, myWork } = sourceFixture(store)
      const other = sourceFixture(store === 'local' ? 'backend' : 'local')
      const personal = { ...project, id: DEFAULT_WORK_ITEM_PROJECT_ID }
      const personalIssue = {
        ...myWork,
        id: 'personal-second-page',
        cloud_project_id: personal.id,
        title: 'Personal task from the second page',
      }
      api.projects.get.mockResolvedValue(personal)
      api.myWork.page
        .mockResolvedValueOnce({ items: [myWork], nextCursor: 'opaque-personal-page' })
        .mockRejectedValueOnce(new Error('Discovery temporarily unavailable'))
        .mockResolvedValueOnce({ items: [myWork, personalIssue], nextCursor: null })
      api.issues.list.mockImplementation(async id =>
        id === personal.id ? [personalIssue] : [myWork]
      )
      const sources = [source, other.source]
      const { result } = renderHook(() => useExperienceTasks(sources, [7], true, 'all'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(api.myWork.page).toHaveBeenCalledTimes(1)
      expect(api.projects.get).not.toHaveBeenCalled()
      expect(result.current.hasMore).toBe(true)

      await act(() => result.current.loadMore())
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.relatedError).toBe(true)
      expect(result.current.hasMore).toBe(true)
      expect(result.current.projects.find(row => row.project === project)?.issues).toContainEqual(
        expect.objectContaining({ id: myWork.id })
      )
      expect(other.api.myWork.page).toHaveBeenCalledTimes(1)

      await act(() => result.current.loadMore())
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.relatedError).toBe(false)
      expect(result.current.hasMore).toBe(false)
      expect(api.myWork.page.mock.calls.slice(1)).toEqual([
        [expect.objectContaining({ cursor: 'opaque-personal-page', limit: 30 })],
        [expect.objectContaining({ cursor: 'opaque-personal-page', limit: 30 })],
      ])
      expect(api.projects.get.mock.calls).toEqual([[personal.id]])
      expect(other.api.projects.get).not.toHaveBeenCalled()
      expect(api.issues.list).toHaveBeenCalledWith(personal.id)
      const rows = selectTaskRows(
        { projects: result.current.projects, viewer: 7 },
        { relevance: 'all' }
      )
      expect(
        rows
          .filter(row => row.project.store === store)
          .map(row => row.id)
          .sort()
      ).toEqual([myWork.id, personalIssue.id].sort())
      expect(api.myWork.page).toHaveBeenCalledTimes(3)
    }
  )

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
