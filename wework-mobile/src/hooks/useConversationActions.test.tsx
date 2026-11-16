import React, { createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/runtime'
import { useConversationActions } from './useConversationActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const archive = vi.hoisted(() => vi.fn())
vi.mock('@/services/mobileConversationArchive', () => ({ archiveMobileConversation: archive }))

describe('conversation mutations', () => {
  let renderer: ReactTestRenderer
  let actions: ReturnType<typeof useConversationActions>
  const address = { deviceId: 'device', taskId: 'task', runtime: 'codex', workspacePath: '/repo' }
  const currentAddress = createRef<RuntimeTaskAddress | null>()
  const api = { renameRuntimeTask: vi.fn(), setRuntimeTaskPinned: vi.fn() }
  const reloadWork = vi.fn()
  const setCurrentTitle = vi.fn()
  const clearCurrentConversation = vi.fn()
  const setError = vi.fn()
  const work: RuntimeWorkListResponse = {
    projects: [],
    chats: [
      {
        deviceId: 'device',
        deviceName: 'Device',
        deviceStatus: 'online',
        available: true,
        workspacePath: '/repo',
        tasks: [
          {
            taskId: 'task',
            threadId: 'thread',
            runtime: 'codex',
            title: 'Title',
            workspacePath: '/repo',
          },
        ],
      },
    ],
    totalTasks: 1,
  }
  function Harness() {
    actions = useConversationActions({
      api: api as unknown as RuntimeApi,
      work,
      currentAddress,
      reloadWork,
      setCurrentTitle,
      clearCurrentConversation,
      setError,
    })
    return null
  }
  beforeEach(async () => {
    vi.resetAllMocks()
    api.renameRuntimeTask.mockResolvedValue({ accepted: true })
    api.setRuntimeTaskPinned.mockResolvedValue({ accepted: true })
    archive.mockResolvedValue({ cleanupError: null })
    currentAddress.current = address
    await act(() => {
      renderer = create(<Harness />)
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
  })
  it('pins the runtime thread and refreshes the owning device', async () => {
    await actions.setConversationPinned(address, true)
    expect(api.setRuntimeTaskPinned).toHaveBeenCalledWith({
      deviceId: 'device',
      threadId: 'thread',
      pinned: true,
    })
    expect(reloadWork).toHaveBeenCalledWith('device')
  })
  it('shows rejection without applying a renamed title or refreshing', async () => {
    api.renameRuntimeTask.mockResolvedValue({ accepted: false, error: 'offline' })
    await expect(actions.renameConversation(address, 'New')).rejects.toThrow('offline')
    expect(setCurrentTitle).not.toHaveBeenCalled()
    expect(reloadWork).not.toHaveBeenCalled()
  })
  it('updates the active title after the server accepts it', async () => {
    await actions.renameConversation(address, 'New')
    expect(setCurrentTitle).toHaveBeenCalledWith('New')
    expect(api.renameRuntimeTask).toHaveBeenCalledWith({ address, title: 'New' })
  })
  it('does not rename the next conversation when a pending mutation completes', async () => {
    currentAddress.current = { ...address, taskId: 'next' }
    await actions.renameConversation(address, 'New')
    expect(setCurrentTitle).not.toHaveBeenCalled()
  })
  it('clears the archived conversation and reports cleanup failure without reversing success', async () => {
    archive.mockResolvedValue({ cleanupError: 'cleanup failed' })
    await actions.archiveConversation(address)
    expect(clearCurrentConversation).toHaveBeenCalledOnce()
    expect(setError).toHaveBeenCalledWith('cleanup failed')
    expect(reloadWork).toHaveBeenCalledWith('device')
  })
  it('does not clear the conversation when archival is rejected', async () => {
    archive.mockRejectedValue(new Error('rejected'))
    await expect(actions.archiveConversation(address)).rejects.toThrow('rejected')
    expect(clearCurrentConversation).not.toHaveBeenCalled()
  })
  it('reports refresh failure after accepted archive without repeating the mutation', async () => {
    reloadWork.mockRejectedValue(new Error('refresh failed'))
    await expect(actions.archiveConversation(address)).resolves.toBeUndefined()
    expect(archive).toHaveBeenCalledOnce()
    expect(setError).toHaveBeenCalledWith('refresh failed')
  })
})
