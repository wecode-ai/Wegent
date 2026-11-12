import { fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import type { ProjectSpaceApi } from './projectSpaceSelection'
import { WorkItemContextPanel, type WorkItemContextPanelProps } from './WorkItemContextPanel'

const lifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }))

function DraftLeaf({ title, version }: { title: string; version: number }) {
  const [draft, setDraft] = useState('')
  useEffect(() => {
    lifecycle.mounted()
    return () => lifecycle.unmounted()
  }, [])
  return (
    <input
      aria-label={title}
      data-testid="context-draft"
      data-version={version}
      value={draft}
      onChange={event => setDraft(event.target.value)}
    />
  )
}

vi.mock('@/features/collaboration/GroupThreadContextPanel', () => ({
  GroupThreadContextPanel: ({ item }: WorkItemContextPanelProps) => (
    <DraftLeaf title={item.title} version={item.version} />
  ),
}))

vi.mock('./TodoEditor', () => ({
  TodoEditor: ({ item }: { item: CloudLoopItem }) => (
    <DraftLeaf title={item.title} version={item.version} />
  ),
}))

function fixture(groupOwned: boolean): WorkItemContextPanelProps {
  return {
    api: {
      listLoopItems: vi.fn(async () => ({ items: [] })),
    } as unknown as ProjectSpaceApi,
    services: {},
    project: { id: 'owner-1', project_store: 'backend' } as CloudProject,
    item: {
      id: 'item-1',
      cloud_project_id: 'owner-1',
      ...(groupOwned ? { group_id: 'owner-1' } : {}),
      title: 'Current item',
      version: 1,
    } as CloudLoopItem,
    currentTask: { deviceId: 'device-1', taskId: 'task-1' },
    currentUserId: 7,
    onOpenTask: vi.fn(),
  }
}

function tree(props: WorkItemContextPanelProps, apiBaseUrl = 'https://account-a.example.test') {
  const connection: CloudConnectionContextValue = {
    ...DISCONNECTED_STATE,
    apiBaseUrl,
    isConnected: false,
    serviceKey: 'test-account',
    connectWithAuthorization: vi.fn(),
    refreshUser: vi.fn(async () => null),
    disconnect: vi.fn(),
  }
  return (
    <CloudConnectionContext.Provider value={connection}>
      <WorkItemContextPanel {...props} />
    </CloudConnectionContext.Provider>
  )
}

beforeEach(() => vi.clearAllMocks())

describe.each([
  ['Group', true],
  ['Project', false],
] as const)('%s context resource identity', (_label, groupOwned) => {
  it(
    groupOwned
      ? 'preserves the Group draft during a version refresh'
      : 'initializes the Project editor with the refreshed version',
    async () => {
      const props = fixture(groupOwned)
      const view = render(tree(props))
      const input = await screen.findByTestId('context-draft')
      fireEvent.change(input, { target: { value: 'Keep my unsent draft' } })
      view.rerender(tree({ ...props, item: { ...props.item, version: 2 } }))
      const refreshed = screen.getByTestId('context-draft')
      expect(refreshed).toHaveAttribute('data-version', '2')
      if (groupOwned) {
        expect(refreshed).toBe(input)
        expect(refreshed).toHaveValue('Keep my unsent draft')
        expect(lifecycle.mounted).toHaveBeenCalledOnce()
        expect(lifecycle.unmounted).not.toHaveBeenCalled()
      } else {
        expect(refreshed).not.toBe(input)
        expect(refreshed).toHaveValue('')
        expect(lifecycle.mounted).toHaveBeenCalledTimes(2)
        expect(lifecycle.unmounted).toHaveBeenCalledOnce()
      }
    }
  )

  it.each(['item', 'project', 'store', 'task', 'device', 'user', 'account URL'])(
    'clears the old draft when the %s identity changes',
    async dimension => {
      const props = fixture(groupOwned)
      const view = render(tree(props))
      const previous = await screen.findByTestId('context-draft')
      fireEvent.change(previous, { target: { value: 'Private old-scope draft' } })
      const next = { ...props }
      if (dimension === 'item') next.item = { ...props.item, id: 'item-2' }
      if (dimension === 'project') next.project = { ...props.project, id: 'owner-2' }
      if (dimension === 'store') next.project = { ...props.project, project_store: 'local' }
      if (dimension === 'task') next.currentTask = { deviceId: 'device-1', taskId: 'task-2' }
      if (dimension === 'device') next.currentTask = { deviceId: 'device-2', taskId: 'task-1' }
      if (dimension === 'user') next.currentUserId = 8
      view.rerender(
        tree(next, dimension === 'account URL' ? 'https://account-b.example.test' : undefined)
      )
      const current = screen.getByTestId('context-draft')
      expect(current).not.toBe(previous)
      expect(current).toHaveValue('')
      expect(lifecycle.mounted).toHaveBeenCalledTimes(2)
      expect(lifecycle.unmounted).toHaveBeenCalledOnce()
    }
  )
})

it('resets the Group editor when the owning Group changes even if other input IDs are stale', async () => {
  const props = fixture(true)
  const view = render(tree(props))
  const previous = await screen.findByTestId('context-draft')
  fireEvent.change(previous, { target: { value: 'Old Group draft' } })
  view.rerender(tree({ ...props, item: { ...props.item, group_id: 'group-2' } }))
  expect(screen.getByTestId('context-draft')).not.toBe(previous)
  expect(screen.getByTestId('context-draft')).toHaveValue('')
})
