// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { useKnowledgeUrlSync } from '@/features/knowledge/document/hooks/useKnowledgeUrlSync'

let mockParams = new URLSearchParams()
let mockPathname = '/knowledge'
const mockReplace = jest.fn()
const mockPush = jest.fn()
jest.mock('next/navigation', () => ({
  useSearchParams: () => mockParams,
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}))
const actions = () => ({
  allKnowledgeBases: [],
  organizationKnowledgeBases: [],
  isGroupsLoading: false,
  selectKb: jest.fn(),
  selectGroup: jest.fn(),
  selectGroups: jest.fn(),
  selectSourceView: jest.fn(),
  clearSelection: jest.fn(),
})
beforeEach(() => {
  mockParams = new URLSearchParams()
  mockPathname = '/knowledge'
  jest.clearAllMocks()
})

it.each(['personal', 'shared', 'organization', 'group-team'])(
  'retains the existing %s query and reapplies it after scope changes',
  group => {
    mockParams = new URLSearchParams({ group, taskId: 'unchanged' })
    const callbacks = actions()
    const { rerender } = renderHook(
      ({ scopeKey }) => useKnowledgeUrlSync({ ...callbacks, scopeKey }),
      { initialProps: { scopeKey: 'first' } }
    )
    expect(callbacks.selectGroup).toHaveBeenLastCalledWith(group)
    const calls = callbacks.selectGroup.mock.calls.length
    rerender({ scopeKey: 'next-user' })
    expect(callbacks.selectGroup.mock.calls.length).toBe(calls + 1)
    expect(callbacks.selectGroup).toHaveBeenLastCalledWith(group)
  }
)

it('preserves the external source and legacy team overview URLs', () => {
  const callbacks = actions()
  mockParams = new URLSearchParams({ group: 'source:external' })
  const { rerender } = renderHook(() => useKnowledgeUrlSync(callbacks))
  expect(callbacks.selectSourceView).toHaveBeenCalledWith('external')
  mockParams = new URLSearchParams({ group: 'all-groups' })
  rerender()
  expect(callbacks.selectGroups).toHaveBeenCalled()
})

it('clears an unavailable library and preserves task parameters when changing groups', () => {
  const callbacks = actions()
  mockParams = new URLSearchParams({ kb: '999', taskId: 'task-1' })
  const { result } = renderHook(() => useKnowledgeUrlSync(callbacks))
  expect(callbacks.clearSelection).toHaveBeenCalled()
  act(() => result.current.updateUrlParams({ group: 'shared', kb: null }))
  expect(mockReplace).toHaveBeenLastCalledWith('?taskId=task-1&type=document&group=shared', {
    scroll: false,
  })
})
