import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { IssueHumanRequest } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useIssueHumanInteractions } from './useIssueHumanInteractions'
import { issueHumanInteraction } from './issueHumanInteractions'
import { canReplyToInteraction } from './runtimeInteractions'

const question: IssueHumanRequest = {
  id: 'question',
  project_id: 'project',
  issue_id: 'ISSUE-1',
  root_comment_id: 'root',
  runtime_device_id: 'device',
  runtime_task_id: 'task',
  item_id: 'native-item',
  question: 'Choose scope',
  recipient_user_id: 0,
  recipient_name: 'local',
  blocks_progress: false,
  status: 'pending',
  version: 1,
  created_at: '2026-11-07T00:00:00Z',
  updated_at: '2026-11-07T00:00:00Z',
}

it('does not block local questions on a failed cloud inbox', async () => {
  const services = {
    localIssueHumanRequestsApi: { inbox: vi.fn().mockResolvedValue({ items: [question] }) },
    issueHumanRequestsApi: { inbox: vi.fn().mockRejectedValue(new Error('Cloud disconnected')) },
  } as unknown as WorkbenchServices
  const { result } = renderHook(() => useIssueHumanInteractions(services, []))
  await act(async () => {
    await result.current.discover(true)
  })
  await waitFor(() => expect(result.current.items).toHaveLength(1))
  expect(result.current.items[0].project?.store).toBe('local')
  await waitFor(() => expect(result.current.errors['issue:backend']).toBe('Cloud disconnected'))
})

it('disables previously loaded answers on a failed refresh and restores them only after validation', async () => {
  const inbox = vi.fn().mockResolvedValue({ items: [question] })
  const services = { localIssueHumanRequestsApi: { inbox } } as unknown as WorkbenchServices
  const { result } = renderHook(() => useIssueHumanInteractions(services, []))
  await act(async () => {
    await result.current.discover(true)
  })
  await waitFor(() => expect(result.current.items).toHaveLength(1))
  expect(canReplyToInteraction(result.current.items[0])).toBe(true)
  inbox.mockRejectedValueOnce(new Error('Offline'))
  await act(async () => {
    await result.current.refresh()
  })
  expect(canReplyToInteraction(result.current.items[0])).toBe(false)
  await act(async () => {
    await result.current.refresh()
  })
  expect(canReplyToInteraction(result.current.items[0])).toBe(true)
})

it('preserves cached questions offline without restoring answer authority', async () => {
  const cached = { ...issueHumanInteraction(question, 'local'), cached: true }
  const services = {
    localIssueHumanRequestsApi: { inbox: vi.fn().mockRejectedValue(new Error('Offline')) },
  } as unknown as WorkbenchServices
  const { result } = renderHook(() => useIssueHumanInteractions(services, [cached]))
  await waitFor(() => expect(result.current.errors['issue:local']).toBe('Offline'))
  expect(result.current.items).toHaveLength(1)
  expect(canReplyToInteraction(result.current.items[0])).toBe(false)
})

it('ignores late results from an old account service', async () => {
  let oldResponse!: (value: { items: IssueHumanRequest[] }) => void
  const old = {
    localIssueHumanRequestsApi: {
      inbox: vi.fn(
        () =>
          new Promise(resolve => {
            oldResponse = resolve
          })
      ),
    },
  } as unknown as WorkbenchServices
  const next = {
    localIssueHumanRequestsApi: { inbox: vi.fn().mockResolvedValue({ items: [] }) },
  } as unknown as WorkbenchServices
  const { result, rerender } = renderHook(
    ({ services }) => useIssueHumanInteractions(services, []),
    { initialProps: { services: old } }
  )
  act(() => {
    void result.current.discover(true)
  })
  await waitFor(() => expect(oldResponse).toBeTypeOf('function'))
  rerender({ services: next })
  await act(async () => {
    oldResponse({ items: [question] })
  })
  expect(result.current.items).toEqual([])
})

it('removes a previous account question even if the new account inbox is offline', async () => {
  const old = {
    issueHumanRequestsApi: { inbox: vi.fn().mockResolvedValue({ items: [question] }) },
  } as unknown as WorkbenchServices
  const next = {
    issueHumanRequestsApi: { inbox: vi.fn().mockRejectedValue(new Error('Offline')) },
  } as unknown as WorkbenchServices
  const { result, rerender } = renderHook(
    ({ services }) => useIssueHumanInteractions(services, []),
    { initialProps: { services: old } }
  )
  await waitFor(() => expect(result.current.items).toHaveLength(1))
  rerender({ services: next })
  await waitFor(() => expect(result.current.errors['issue:backend']).toBe('Offline'))
  expect(result.current.items).toEqual([])
})

it('keeps an empty local workbench quiet and uses the existing discovery hint for durable questions', async () => {
  const inbox = vi.fn().mockResolvedValue({ items: [question] })
  const list = vi.fn().mockResolvedValue({ items: [{ ...question, status: 'resolved' }] })
  const services = { localIssueHumanRequestsApi: { inbox, list } } as unknown as WorkbenchServices
  const { result } = renderHook(() => useIssueHumanInteractions(services, []))
  await act(async () => {
    await result.current.discover(false)
  })
  expect(inbox).not.toHaveBeenCalled()
  await act(async () => {
    await result.current.discover(true)
  })
  expect(result.current.items).toHaveLength(1)
  inbox.mockResolvedValue({ items: [] })
  await act(async () => {
    await result.current.discover(false)
  })
  expect(result.current.items).toEqual([])
  await act(async () => {
    await result.current.discover(false)
  })
  expect(inbox).toHaveBeenCalledTimes(2)
  await act(async () => {
    await result.current.refresh()
  })
  expect(inbox).toHaveBeenCalledTimes(3)
})

it.each([false, true])('recovers settlement after a failed lookup (remount: %s)', async remount => {
  const inbox = vi.fn().mockResolvedValue({ items: [question] })
  const list = vi.fn().mockRejectedValueOnce(new Error('Issue temporarily offline'))
  const services = {
    issueHumanRequestsApi: { inbox, list },
  } as unknown as WorkbenchServices
  const rendered = renderHook(() => useIssueHumanInteractions(services, []))
  let { result } = rendered
  await waitFor(() => expect(result.current.items).toHaveLength(1))
  inbox.mockResolvedValue({ items: [] })
  await act(async () => result.current.refresh())
  expect(result.current.items).toHaveLength(1)
  expect(result.current.items[0].cached).toBe(true)
  expect(canReplyToInteraction(result.current.items[0])).toBe(false)
  expect(result.current.errors['issue:backend']).toBe('Issue temporarily offline')
  expect(result.current.resolved).toHaveLength(0)
  if (remount) {
    const cached = result.current.items
    rendered.unmount()
    list.mockRejectedValueOnce(new Error('Issue still offline'))
    result = renderHook(() => useIssueHumanInteractions(services, cached)).result
    await waitFor(() => expect(result.current.errors['issue:backend']).toBe('Issue still offline'))
  }
  list.mockResolvedValue({ items: [{ ...question, status: 'resolved' }] })
  await act(async () => result.current.refresh())
  expect(result.current.resolved).toHaveLength(1)
  expect(result.current.items).toHaveLength(0)
  expect(result.current.errors).toEqual({})
})

it('removes reply authority as soon as the inbox removes a question while settlement is loading', async () => {
  const inbox = vi.fn().mockResolvedValue({ items: [question] })
  let complete!: (value: { items: IssueHumanRequest[] }) => void
  const list = vi.fn(
    () => new Promise<{ items: IssueHumanRequest[] }>(resolve => (complete = resolve))
  )
  const services = { issueHumanRequestsApi: { inbox, list } } as unknown as WorkbenchServices
  const { result } = renderHook(() => useIssueHumanInteractions(services, []))
  await waitFor(() => expect(result.current.items).toHaveLength(1))
  inbox.mockResolvedValue({ items: [] })
  let refresh!: Promise<void>
  act(() => {
    refresh = result.current.refresh()
  })
  await waitFor(() => expect(result.current.items[0].cached).toBe(true))
  expect(canReplyToInteraction(result.current.items[0])).toBe(false)
  await act(async () => {
    complete({ items: [{ ...question, status: 'resolved' }] })
    await refresh
  })
  expect(result.current.items).toHaveLength(0)
  expect(result.current.resolved).toHaveLength(1)
})
