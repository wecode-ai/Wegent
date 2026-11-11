import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useMemo, useState, type ReactNode, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatModal } from '@/features/todo/AiChatModal'
import type { ThreadActionContext } from './threadActions'
import {
  GroupThreadPersonalTaskController,
  GroupThreadSurface,
} from './GroupThreadPersonalTaskController'
import { threadActionOwner } from './threadPersonalTaskAccess'

const fixture = vi.hoisted(() => ({
  context: null as ThreadActionContext | null,
  modal: null as ComponentProps<typeof AiChatModal> | null,
}))
vi.mock('@/features/todo/AiChatModal', () => ({
  AiChatModal: (props: ComponentProps<typeof AiChatModal>) => {
    fixture.modal = props
    return props.open ? (
      <div data-testid="private-conversation">
        <button data-testid="close-private" onClick={props.onClose}>
          Close
        </button>
      </div>
    ) : null
  },
}))
vi.mock('./ThreadWorkMetadata', () => ({
  ThreadWorkMetadata: ({
    context,
    onCreate,
  }: {
    context: ThreadActionContext
    onCreate(context: ThreadActionContext): void
  }) => (
    <button data-testid="create-personal" onClick={() => onCreate(context)}>
      Create
    </button>
  ),
}))
vi.mock('./CollaborationGroupsSurface', () => ({
  CollaborationGroupsSurface: (props: {
    renderThreadActions?(context: ThreadActionContext): ReactNode
    onThreadActionContext?(context: ThreadActionContext | null): void
  }) => {
    const { onThreadActionContext } = props
    const [editing, setEditing] = useState(true)
    const context = useMemo(
      () => ({
        ...fixture.context!,
        requestLeave: (action: () => void) => {
          setEditing(false)
          action()
        },
      }),
      []
    )
    useEffect(() => {
      onThreadActionContext?.(context)
      return () => onThreadActionContext?.(null)
    }, [onThreadActionContext, context])
    return (
      <div data-testid="stable-surface">
        {editing && <div data-testid="metadata-sheet">{props.renderThreadActions?.(context)}</div>}
      </div>
    )
  },
}))
vi.mock('@/features/todo/humanTaskDispatch', () => ({
  resolveHumanTaskDispatch: vi.fn().mockResolvedValue(undefined),
}))

function context(): ThreadActionContext {
  const item = {
    id: 'thread',
    group_id: 'group',
    cloud_project_id: 'group',
    joined: true,
    status: 'pending',
    title: 'Task',
    assignee_user_id: null,
    assignee_agent_id: null,
    assignee_group_id: null,
    assignee_team_id: null,
    version: 1,
  }
  return {
    accountScope: 'account',
    sourceStore: 'local',
    project: { id: 'group', project_store: 'local', resource_type: 'chat_group' },
    group: { id: 'group', role: 'Owner', status: 'active', version: 1 },
    item,
    participation: { current_user_id: 0, joined: true, can_comment: true },
    api: {
      issues: { get: vi.fn().mockResolvedValue(item) },
      assignments: { list: vi.fn().mockResolvedValue([]) },
    },
    requestLeave: action => action(),
  } as unknown as ThreadActionContext
}
afterEach(() => {
  fixture.context = null
  fixture.modal = null
  localStorage.clear()
})

describe('Group private task controller', () => {
  it('closes metadata without unmounting the private editor and retains it across hidden workspaces', async () => {
    fixture.context = context()
    const owner = threadActionOwner(fixture.context)
    const services = {
      projectSpaceApis: { local: { bindTask: vi.fn(), unbindTask: vi.fn() } },
    } as never
    const view = (active: boolean, currentOwner = owner) => (
      <GroupThreadPersonalTaskController
        owner={currentOwner}
        active={active}
        locale="en"
        services={services}
        localProjects={[]}
      >
        <GroupThreadSurface {...({} as ComponentProps<typeof GroupThreadSurface>)} />
      </GroupThreadPersonalTaskController>
    )
    const mounted = render(view(true))
    const surface = screen.getByTestId('stable-surface')
    fireEvent.click(screen.getByTestId('create-personal'))
    await screen.findByTestId('private-conversation')
    expect(screen.queryByTestId('metadata-sheet')).toBeNull()
    expect(screen.getByTestId('stable-surface')).toBe(surface)
    const initialTaskRequest = fixture.modal!.initialTaskRequest
    mounted.rerender(view(false))
    expect(screen.queryByTestId('private-conversation')).toBeNull()
    expect(fixture.modal!.initialTaskRequest).toBe(initialTaskRequest)
    mounted.rerender(view(true))
    expect(screen.getByTestId('private-conversation')).toBeTruthy()
    expect(screen.getByTestId('stable-surface')).toBe(surface)
    mounted.rerender(view(true, 'another-account-store-thread'))
    expect(screen.queryByTestId('private-conversation')).toBeNull()
    expect(screen.getByTestId('stable-surface')).toBe(surface)
    await act(async () => {})
  })

  it('rejects revoked execution before creating the private editor', async () => {
    fixture.context = context()
    const get = vi.mocked(fixture.context.api.issues.get)
    get.mockResolvedValue({ ...fixture.context.item, permissions: { execute: false } } as never)
    render(
      <GroupThreadPersonalTaskController
        owner={threadActionOwner(fixture.context)}
        active
        locale="en"
        services={{} as never}
        localProjects={[]}
      >
        <GroupThreadSurface {...({} as never)} />
      </GroupThreadPersonalTaskController>
    )
    fireEvent.click(screen.getByTestId('create-personal'))
    await waitFor(() => expect(get).toHaveBeenCalledOnce())
    await screen.findByTestId('transient-notice')
    expect(screen.queryByTestId('private-conversation')).toBeNull()
  })
})
