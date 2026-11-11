import { act, render, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import type { ChatGroup } from '@/api/chatGroups'
import type { CollaborationIssue } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { ThreadCreationHome } from '@/features/collaboration/ThreadCreationHome'
import { groupWorkContainer } from '@/api/groupWorkContainer'
import '@/i18n'
import { TaskOriginThreadCreateDialog } from './TaskOriginThreadCreateDialog'

const host = vi.hoisted(() => ({
  props: null as ComponentProps<typeof ThreadCreationHome> | null,
  workspace: {},
}))
vi.mock('./localWorkspaceApi', () => ({ createLocalWorkspaceApi: () => host.workspace }))
vi.mock('@/features/collaboration/ThreadCreationHome', () => ({
  ThreadCreationHome: (props: ComponentProps<typeof ThreadCreationHome>) => {
    host.props = props
    return <div data-testid="public-work-form" />
  },
}))
const group = {
  id: 'group',
  project_key: 'G',
  name: 'Group without a project',
  description: '',
  status: 'active',
  role: 'Developer',
  created_by_user_id: 900,
  version: 1,
  created_at: '',
  updated_at: '',
} as ChatGroup
const owner = groupWorkContainer(group, 'local')
const created = {
  id: 'created',
  group_id: group.id,
  cloud_project_id: group.id,
  title: 'Explicit public title',
} as CollaborationIssue
const stored = { ...created, description: 'Explicit public description' } as CloudLoopItem
const user = { id: 7, user_name: 'User', email: 'user@example.test' }

function setup() {
  const api = { getLoopItem: vi.fn().mockResolvedValue(stored) }
  const groups = { get: vi.fn().mockResolvedValue({ group }) }
  const services = {
    projectSpaceApis: { local: api },
    chatGroupApis: { local: groups },
  } as unknown as WorkbenchServices
  const onCreated = vi.fn().mockResolvedValue(undefined)
  const props = {
    services,
    user,
    scopeKey: 'account-a/private-task',
    projects: [],
    onClose: vi.fn(),
    onCreated,
  }
  return { api, groups, props, onCreated }
}

describe('Reviewing public work information before linking a private task', () => {
  it('keeps local group creation available without a cloud login', () => {
    const { props } = setup()
    render(<TaskOriginThreadCreateDialog {...props} user={null} />)
    expect(host.props!.sources).toEqual([
      expect.objectContaining({ store: 'local', workspace: host.workspace }),
    ])
    expect(host.props!.projects).toEqual([])
  })
  it('supports an independent group or a brand new group without offering a fake project or private prompt', async () => {
    const { props, onCreated } = setup()
    const view = render(<TaskOriginThreadCreateDialog {...props} />)
    expect(host.props).toMatchObject({
      projects: [],
      sources: [{ store: 'local' }],
      draftScope: 'task-origin:account-a/private-task',
    })
    expect(host.props!.initialTarget).toBeUndefined()
    expect(host.props).not.toHaveProperty('runtimeTaskDescription')
    expect(host.props).not.toHaveProperty('description')
    view.rerender(<TaskOriginThreadCreateDialog {...props} target={owner} />)
    expect(host.props!.initialTarget).toEqual({ store: 'local', groupId: group.id })
    await act(() => host.props!.onCreated!(created, 'local'))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(stored, owner)
  })

  it('rejects a returned item from another group before any private binding callback', async () => {
    const { props, api, onCreated } = setup()
    api.getLoopItem.mockResolvedValue({ ...stored, group_id: 'another-group' })
    render(<TaskOriginThreadCreateDialog {...props} target={owner} />)
    await expect(host.props!.onCreated!(created, 'local')).rejects.toThrow()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('does not bind a created item after the account changes during its canonical read', async () => {
    const { props, api, onCreated } = setup()
    let resolve!: (item: CloudLoopItem) => void
    const pending = new Promise<CloudLoopItem>(done => {
      resolve = done
    })
    api.getLoopItem.mockReturnValue(pending)
    const view = render(<TaskOriginThreadCreateDialog {...props} target={owner} />)
    const callback = host.props!.onCreated!
    let completed!: Promise<void>
    act(() => {
      completed = Promise.resolve(callback(created, 'local'))
    })
    await waitFor(() => expect(api.getLoopItem).toHaveBeenCalledWith(created.id))
    view.rerender(
      <TaskOriginThreadCreateDialog {...props} scopeKey="account-b/private-task" target={owner} />
    )
    await act(async () => {
      resolve(stored)
      await completed
    })
    expect(onCreated).not.toHaveBeenCalled()
  })
})
