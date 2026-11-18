// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  migrateBaseBoardStatusGrouping,
  useBaseBoardStatusMigration,
  type CollaborationProject,
} from '@wegent/collaboration'
import { StrictMode, type PropsWithChildren } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type MigrationApi = Parameters<typeof migrateBaseBoardStatusGrouping>[0]

function project(overrides: Partial<CollaborationProject> = {}): CollaborationProject {
  return {
    id: 'one',
    public_id: 'one',
    project_key: 'ONE',
    name: 'Project',
    description: '',
    project_store: 'backend',
    task_provider: 'local',
    provider_config: {},
    created_by_user_id: 1,
    access_role: 'Maintainer',
    status: 'active',
    tags: ['design', 'review'],
    version: 3,
    created_at: '',
    updated_at: '',
    board_config: {
      group_by: 'tag',
      processing_start_status_id: 'doing',
      statuses: [
        { id: 'done', name: 'Done', color: 'green' },
        { id: 'doing', name: 'Doing', color: 'blue' },
      ],
    },
    board_views: {
      schema_version: 1,
      default_view_id: 'workflow',
      views: [
        {
          id: 'workflow',
          name: 'Workflow',
          columns: [{ id: 'review', type: 'tag', value: 'review' }],
        },
      ],
    },
    ...overrides,
  }
}

function apiFor(latest = project()) {
  const get = vi.fn<MigrationApi['get']>().mockResolvedValue(latest)
  const update = vi.fn<MigrationApi['update']>().mockImplementation(async (_id, input) => ({
    ...latest,
    version: latest.version + 1,
    board_config: input.boardConfig,
  }))
  return { get, update }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

afterEach(cleanup)

describe('base board status migration', () => {
  it('reads the latest revision and updates only grouping while preserving all other configuration', async () => {
    const latest = project({ version: 8 })
    const api = apiFor(latest)

    const saved = await migrateBaseBoardStatusGrouping(api, latest.id)

    expect(api.get).toHaveBeenCalledWith('one')
    expect(api.update).toHaveBeenCalledExactlyOnceWith('one', {
      version: 8,
      boardConfig: { ...latest.board_config, group_by: 'status' },
    })
    expect(saved?.board_config?.statuses).toEqual(latest.board_config?.statuses)
    expect(saved?.board_config?.processing_start_status_id).toBe('doing')
    expect(saved?.board_views).toEqual(latest.board_views)
    expect(saved?.tags).toEqual(latest.tags)
    expect(latest.board_config?.group_by).toBe('tag')
  })

  it('is idempotent when another client has already migrated the latest project', async () => {
    const latest = project()
    latest.board_config!.group_by = 'status'
    const api = apiFor(latest)

    expect(await migrateBaseBoardStatusGrouping(api, latest.id)).toBe(latest)
    expect(api.update).not.toHaveBeenCalled()
  })

  it('does not mutate a scope that becomes inactive while the fresh project loads', async () => {
    const pending = deferred<CollaborationProject>()
    const api = apiFor()
    api.get.mockReturnValue(pending.promise)
    let current = true
    const migration = migrateBaseBoardStatusGrouping(api, 'one', () => current)
    current = false
    pending.resolve(project())

    expect(await migration).toBeNull()
    expect(api.update).not.toHaveBeenCalled()
  })

  it('starts only for an active authorized project when the flag is enabled', async () => {
    const api = apiFor()
    const onMigrated = vi.fn()
    const { rerender } = renderHook(
      ({ enabled, canManage }) =>
        useBaseBoardStatusMigration({ api, project: project(), enabled, canManage, onMigrated }),
      { initialProps: { enabled: false, canManage: true } }
    )
    expect(api.get).not.toHaveBeenCalled()
    rerender({ enabled: true, canManage: false })
    expect(api.get).not.toHaveBeenCalled()
    rerender({ enabled: true, canManage: true })
    await waitFor(() => expect(onMigrated).toHaveBeenCalledOnce())
    expect(api.update).toHaveBeenCalledOnce()
  })

  it('shares one attempt across strict effect reattachment and delivers the saved project once', async () => {
    const api = apiFor()
    const onMigrated = vi.fn()
    const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>
    const { result, rerender } = renderHook(
      () =>
        useBaseBoardStatusMigration({
          api,
          project: project(),
          enabled: true,
          canManage: true,
          onMigrated,
        }),
      { wrapper }
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(api.get).toHaveBeenCalledOnce()
    expect(api.update).toHaveBeenCalledOnce()
    expect(onMigrated).toHaveBeenCalledOnce()
    rerender()
    expect(api.update).toHaveBeenCalledOnce()
    expect(onMigrated).toHaveBeenCalledOnce()
  })

  it('surfaces a failed write without automatic retries and retries from the latest revision on request', async () => {
    const api = apiFor()
    const conflict = new Error('version conflict')
    api.update.mockRejectedValueOnce(conflict)
    const onMigrated = vi.fn()
    const { result, rerender } = renderHook(() =>
      useBaseBoardStatusMigration({
        api,
        project: project(),
        enabled: true,
        canManage: true,
        onMigrated,
      })
    )

    await waitFor(() => expect(result.current.error).toBe(conflict))
    rerender()
    expect(api.get).toHaveBeenCalledOnce()
    expect(api.update).toHaveBeenCalledOnce()
    api.get.mockResolvedValue(project({ version: 10 }))
    act(() => result.current.retry())
    await waitFor(() => expect(onMigrated).toHaveBeenCalledOnce())
    expect(api.update).toHaveBeenLastCalledWith('one', {
      version: 10,
      boardConfig: { ...project().board_config, group_by: 'status' },
    })
    expect(result.current.error).toBeNull()
  })

  it('hides an old failure and ignores a late completion after selecting another project', async () => {
    const pending = deferred<CollaborationProject>()
    const api = apiFor()
    api.update.mockReturnValueOnce(pending.promise)
    const onMigrated = vi.fn()
    const { result, rerender } = renderHook(
      ({ selected }) =>
        useBaseBoardStatusMigration({
          api,
          project: selected,
          enabled: true,
          canManage: true,
          onMigrated,
        }),
      { initialProps: { selected: project() } }
    )
    await waitFor(() => expect(api.update).toHaveBeenCalledOnce())
    const next = project({ id: 'two' })
    next.board_config!.group_by = 'status'
    rerender({ selected: next })
    await act(async () => pending.resolve(project({ version: 4 })))

    expect(result.current.error).toBeNull()
    expect(result.current.pending).toBe(false)
    expect(onMigrated).not.toHaveBeenCalled()
    expect(api.get).toHaveBeenCalledOnce()
  })

  it('does not write after unmounting while the fresh project is still loading', async () => {
    const pending = deferred<CollaborationProject>()
    const api = apiFor()
    api.get.mockReturnValue(pending.promise)
    const onMigrated = vi.fn()
    const { unmount } = renderHook(() =>
      useBaseBoardStatusMigration({
        api,
        project: project(),
        enabled: true,
        canManage: true,
        onMigrated,
      })
    )
    unmount()
    await act(async () => pending.resolve(project()))

    expect(api.update).not.toHaveBeenCalled()
    expect(onMigrated).not.toHaveBeenCalled()
  })

  it('starts a fresh attempt when an abandoned pre-write load is enabled again', async () => {
    const pending = deferred<CollaborationProject>()
    const api = apiFor()
    api.get.mockReturnValueOnce(pending.promise)
    const onMigrated = vi.fn()
    const { rerender } = renderHook(
      ({ enabled }) =>
        useBaseBoardStatusMigration({
          api,
          project: project(),
          enabled,
          canManage: true,
          onMigrated,
        }),
      { initialProps: { enabled: true } }
    )
    rerender({ enabled: false })
    await act(async () => pending.resolve(project()))
    expect(api.update).not.toHaveBeenCalled()
    rerender({ enabled: true })

    await waitFor(() => expect(onMigrated).toHaveBeenCalledOnce())
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(api.update).toHaveBeenCalledOnce()
  })

  it('starts a new attempt after leaving and returning to an abandoned project', async () => {
    const pending = deferred<CollaborationProject>()
    const api = apiFor()
    api.get.mockReturnValueOnce(pending.promise)
    const onMigrated = vi.fn()
    const { rerender } = renderHook(
      ({ selected }: { selected: CollaborationProject | null }) =>
        useBaseBoardStatusMigration({
          api,
          project: selected,
          enabled: true,
          canManage: true,
          onMigrated,
        }),
      { initialProps: { selected: project() as CollaborationProject | null } }
    )
    rerender({ selected: null })
    await act(async () => pending.resolve(project()))
    expect(api.update).not.toHaveBeenCalled()
    rerender({ selected: project() })

    await waitFor(() => expect(onMigrated).toHaveBeenCalledOnce())
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(api.update).toHaveBeenCalledOnce()
  })
})
