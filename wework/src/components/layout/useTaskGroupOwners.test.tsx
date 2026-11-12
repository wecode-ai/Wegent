import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { useTaskGroupOwners } from './useTaskGroupOwners'

const group = {
  id: 'independent',
  name: 'Independent group',
  project_key: 'G',
  status: 'active',
  role: 'Developer',
  created_by_user_id: 900,
  version: 1,
} as ChatGroup
const api = (list: ReturnType<typeof vi.fn>) => ({ list }) as unknown as ChatGroupApi

describe('Task group owner catalog', () => {
  it('offers standalone writable groups even when the other storage cannot load', async () => {
    const local = api(
      vi.fn().mockResolvedValue({
        items: [
          group,
          { ...group, id: 'viewer', role: 'Viewer' },
          { ...group, id: 'archived', status: 'archived' },
        ],
      })
    )
    const cloud = api(vi.fn().mockRejectedValue(new Error('Cloud unavailable')))
    const { result } = renderHook(() => useTaskGroupOwners(true, { local, cloud }, 'account-a'))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0]).toMatchObject({
      id: group.id,
      resource_type: 'chat_group',
      project_store: 'local',
    })
    expect(result.current[0]).not.toHaveProperty('project_id')
  })

  it('hides old-account groups immediately and discards a late response after switching accounts', async () => {
    let resolve!: (value: { items: ChatGroup[] }) => void
    const local = api(vi.fn().mockResolvedValue({ items: [group] }))
    const cloud = api(
      vi.fn().mockImplementation(
        () =>
          new Promise(value => {
            resolve = value
          })
      )
    )
    const apis = { local, cloud }
    const { result, rerender } = renderHook(
      ({ account, active }) => useTaskGroupOwners(active, apis, account),
      { initialProps: { account: 'account-a', active: true } }
    )
    await waitFor(() => expect(result.current).toHaveLength(1))
    rerender({ account: 'account-b', active: false })
    expect(result.current).toEqual([])
    await act(async () => resolve({ items: [{ ...group, id: 'late-private-group' }] }))
    expect(result.current).toEqual([])
  })
})
