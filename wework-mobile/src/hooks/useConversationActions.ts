import { useCallback, type MutableRefObject } from 'react'
import { conversationPinTarget } from '@/domain/conversationActions'
import type { RuntimeApi } from '@/services/runtimeApi'
import { archiveMobileConversation } from '@/services/mobileConversationArchive'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/runtime'

interface Options {
  api: RuntimeApi
  work: RuntimeWorkListResponse
  currentAddress: MutableRefObject<RuntimeTaskAddress | null>
  reloadWork: (deviceId: string) => Promise<unknown>
  setCurrentTitle: (title: string) => void
  clearCurrentConversation: () => void
  setError: (error: string) => void
}

export function useConversationActions({
  api,
  work,
  currentAddress,
  reloadWork,
  setCurrentTitle,
  clearCurrentConversation,
  setError,
}: Options) {
  const setConversationPinned = useCallback(
    async (address: RuntimeTaskAddress, pinned: boolean) => {
      const target = conversationPinTarget(work, address)
      if (!target) throw new Error('会话尚未建立，暂时无法置顶')
      const result = await api.setRuntimeTaskPinned({
        deviceId: target.deviceId,
        threadId: target.threadId,
        pinned,
      })
      if (!result.accepted) throw new Error(result.error || '无法更新会话置顶状态')
      await reloadWork(target.deviceId)
    },
    [api, reloadWork, work]
  )

  const renameConversation = useCallback(
    async (address: RuntimeTaskAddress, title: string) => {
      const result = await api.renameRuntimeTask({ address, title })
      if (!result.accepted) throw new Error(result.error || '重命名会话失败')
      if (
        currentAddress.current?.deviceId === address.deviceId &&
        currentAddress.current.taskId === address.taskId
      )
        setCurrentTitle(title)
      await reloadWork(address.deviceId)
    },
    [api, currentAddress, reloadWork, setCurrentTitle]
  )

  const archiveConversation = useCallback(
    async (address: RuntimeTaskAddress) => {
      const { cleanupError } = await archiveMobileConversation(api, work, address)
      if (
        currentAddress.current?.deviceId === address.deviceId &&
        currentAddress.current.taskId === address.taskId
      )
        clearCurrentConversation()
      if (cleanupError) setError(cleanupError)
      // The accepted archive is complete even if refreshing the list fails.
      try {
        await reloadWork(address.deviceId)
      } catch (cause) {
        setError(
          [cleanupError, cause instanceof Error ? cause.message : String(cause)]
            .filter(Boolean)
            .join('\n')
        )
      }
    },
    [api, work, currentAddress, clearCurrentConversation, reloadWork, setError]
  )

  return { setConversationPinned, renameConversation, archiveConversation }
}
