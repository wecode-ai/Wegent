// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@/i18n'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WeworkSharedProject } from './WeworkCollaborationPlatform'

const editor = vi.hoisted(() => ({ api: null as SharedWorkspaceApi | null }))
const originalGetAnimations = Element.prototype.getAnimations
vi.mock('./TodoEditor', () => ({
  TodoEditor: ({ sharedApi }: { sharedApi: SharedWorkspaceApi }) => {
    editor.api = sharedApi
    return <div data-testid="snapshot-test-editor" />
  },
}))
vi.mock('./StandInPopover', () => ({ StandInPopover: () => null }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => false,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createFixture(projectStore: 'local' | 'backend', version = 1) {
  let project: CollaborationProject = {
    id: 'project-1',
    project_store: projectStore,
    public_id: 'public-1',
    project_key: 'PRJ',
    name: `Project v${version}`,
    description: '',
    task_provider: 'local',
    provider_config: {},
    created_by_user_id: 1,
    access_role: 'Owner',
    status: 'active',
    tags: ['old'],
    version,
    created_at: '2026-11-17T00:00:00Z',
    updated_at: '2026-11-17T00:00:00Z',
    board_views: {
      schema_version: 1,
      default_view_id: 'phases',
      views: [
        { id: 'phases', name: 'Phases', columns: [{ id: 'old', type: 'tag', value: 'old' }] },
      ],
    },
  }
  const issue: CollaborationIssue = {
    id: 'detail-only',
    cloud_project_id: project.id,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: 'Detail outside the board snapshot',
    description: '',
    status: 'pending',
    priority: 'none',
    tags: [],
    due_at: null,
    sort_order: 0,
    version: 1,
    created_at: project.created_at,
    updated_at: project.updated_at,
    completed_at: null,
  }
  const snapshot = { items: [issue], members: [], agents: [], taskBindings: [] }
  const get = vi.fn(async () => project)
  const update = vi.fn(
    async (_id: string, input: Parameters<SharedWorkspaceApi['projects']['update']>[1]) => {
      project = {
        ...project,
        name: input.name ?? project.name,
        tags: input.tags ?? project.tags,
        board_views: input.boardViews ?? project.board_views,
        version: project.version + 1,
      }
      return project
    }
  )
  const updateIssue = vi.fn(async () => issue)
  const getBoardSnapshot = vi.fn(async () => snapshot)
  const api = {
    projects: {
      list: vi.fn(async () => [project]),
      get,
      update,
      listExecutionEnvironments: vi.fn(async () => []),
    },
    issues: {
      getBoardSnapshot,
      get: vi.fn(async () => issue),
      list: vi.fn(async () => [issue]),
      create: vi.fn(async () => issue),
      update: updateIssue,
    },
    attachments: { list: vi.fn(async () => []) },
    comments: { list: vi.fn(async () => []) },
    assignments: { list: vi.fn(async () => []) },
    executions: { list: vi.fn(async () => []) },
    taskBindings: { list: vi.fn(async () => []) },
  } as unknown as SharedWorkspaceApi
  const props = {
    api,
    project,
    localProjects: [],
    locale: 'en',
    location: {
      platformView: 'spaces',
      collaborationDomain: projectStore === 'local' ? 'local' : 'cloud',
      workspaceId: 'workspace-1',
      workspaceView: 'projects',
      projectId: project.id,
      projectView: 'board',
      issueId: issue.id,
    },
    workspace: { id: 'workspace-1', name: 'Workspace' },
    services: {},
    userId: 1,
    setLocation: vi.fn(),
  } as unknown as ComponentProps<typeof WeworkSharedProject>
  return {
    api,
    props,
    snapshot,
    get,
    getBoardSnapshot,
    updateIssue,
    advance() {
      project = {
        ...project,
        version: project.version + 1,
        name: `Project v${project.version + 1}`,
        tags: ['new'],
        board_views: {
          schema_version: 1,
          default_view_id: 'phases',
          views: [
            { id: 'phases', name: 'Phases', columns: [{ id: 'new', type: 'tag', value: 'new' }] },
          ],
        },
      }
    },
  }
}

async function expectFresh() {
  await waitFor(() =>
    expect(screen.getByTestId('project-snapshot-sync-state')).toHaveAttribute(
      'data-sync-state',
      'fresh'
    )
  )
}

beforeEach(() => {
  Element.prototype.getAnimations = vi.fn(() => [])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalGetAnimations) Element.prototype.getAnimations = originalGetAnimations
  else Reflect.deleteProperty(Element.prototype, 'getAnimations')
  editor.api = null
  localStorage.clear()
})

describe('production project snapshot lifecycle', () => {
  it('keeps personal Issue actions available without a project board controller or workspace', async () => {
    const fixture = createFixture('backend')
    render(
      <WeworkSharedProject
        {...fixture.props}
        workspace={null}
        location={{ ...fixture.props.location, projectId: null, issueId: null }}
        personalIssue={{
          issue: {
            ...fixture.snapshot.items[0],
            project_key: fixture.props.project.project_key,
            project_name: fixture.props.project.name,
            has_active_task: false,
          },
          project: fixture.props.project,
          active: true,
          onUpdated: vi.fn(),
          onOpenIssue: vi.fn(),
        }}
      />
    )
    await screen.findByTestId('snapshot-test-editor')
    expect(screen.queryByTestId('project-snapshot-sync-state')).not.toBeInTheDocument()
    expect(fixture.get).not.toHaveBeenCalled()
    expect(fixture.getBoardSnapshot).not.toHaveBeenCalled()
    await expect(
      editor.api!.issues.create('project-1', { title: 'Personal detail child' })
    ).resolves.toEqual(fixture.snapshot.items[0])
    expect(fixture.api.issues.create).toHaveBeenCalledOnce()
  })

  it.each(['backend', 'local'] as const)(
    'revalidates %s projects on activation and protects stale detail writes',
    async projectStore => {
      const fixture = createFixture(projectStore)
      const view = render(<WeworkSharedProject {...fixture.props} />)
      await expectFresh()
      await screen.findByTestId('snapshot-test-editor')
      expect(screen.getByTestId('cloud-todo-column-old')).toBeInTheDocument()

      view.rerender(<WeworkSharedProject {...fixture.props} workspaceActive={false} />)
      fixture.advance()
      const requests = fixture.get.mock.calls.length
      fireEvent.focus(window)
      expect(fixture.get).toHaveBeenCalledTimes(requests)
      view.rerender(<WeworkSharedProject {...fixture.props} workspaceActive />)
      await expectFresh()
      expect(screen.getByTestId('cloud-todo-column-new')).toBeInTheDocument()
      expect(screen.queryByTestId('cloud-todo-column-old')).not.toBeInTheDocument()
      expect(screen.getByText('Project v2')).toBeInTheDocument()

      await act(async () => {
        await editor.api!.projects.update('project-1', {
          version: 2,
          name: 'Saved here',
          boardViews: { schema_version: 1, views: [] },
        })
      })
      expect(screen.getByText('Saved here')).toBeInTheDocument()
      expect(screen.queryByTestId('cloud-todo-column-new')).not.toBeInTheDocument()

      fixture.get.mockRejectedValueOnce(new Error('Network unavailable'))
      fireEvent.focus(window)
      await waitFor(() =>
        expect(screen.getByTestId('project-snapshot-sync-state')).toHaveAttribute(
          'data-sync-state',
          'stale'
        )
      )
      expect(screen.getByTestId('collaboration-issue-create')).toBeDisabled()
      expect(screen.getByText('Saved here')).toBeInTheDocument()
      await expect(
        editor.api!.issues.update('detail-only', { version: 1, status: 'completed' })
      ).rejects.toThrow()
      expect(fixture.updateIssue).not.toHaveBeenCalled()
      await expect(
        editor.api!.issues.update('detail-only', { version: 1, title: 'Safe text edit' })
      ).resolves.toBeDefined()

      fireEvent.click(screen.getByTestId('project-snapshot-retry'))
      await expectFresh()
      expect(screen.getByTestId('collaboration-issue-create')).toBeEnabled()
    }
  )

  it('keeps the initial board pending through same-version revalidation and then clears loading', async () => {
    const fixture = createFixture('backend')
    const pending = deferred<typeof fixture.snapshot>()
    fixture.getBoardSnapshot.mockReturnValueOnce(pending.promise)
    render(<WeworkSharedProject {...fixture.props} />)
    await waitFor(() => expect(fixture.get).toHaveBeenCalledOnce())
    expect(fixture.getBoardSnapshot).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('cloud-todo-column-old')).not.toBeInTheDocument()
    await act(async () => {
      pending.resolve(fixture.snapshot)
    })
    await expectFresh()
    expect(screen.getByTestId('cloud-todo-column-old')).toBeInTheDocument()
  })

  it('resets a same-id project to its new API scope even when its version is lower', async () => {
    const first = createFixture('backend', 5)
    const second = createFixture('backend', 1)
    const view = render(<WeworkSharedProject {...first.props} />)
    await expectFresh()
    expect(screen.getByText('Project v5')).toBeInTheDocument()

    view.rerender(<WeworkSharedProject {...second.props} />)
    await expectFresh()
    expect(screen.getByText('Project v1')).toBeInTheDocument()
    expect(screen.queryByText('Project v5')).not.toBeInTheDocument()
    expect(second.get).toHaveBeenCalledOnce()
  })
})
