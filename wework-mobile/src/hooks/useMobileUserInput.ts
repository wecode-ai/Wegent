import * as Crypto from 'expo-crypto'
import { useCallback, useRef, type RefObject } from 'react'
import {
  requestUserInputResponseKey,
  requestUserInputResponseText,
} from '../../../packages/chat-core/src/runtime-user-input'

import type { ChatAction } from '@/domain/chatReducer'
import {
  isAsyncRequestUserInputPayload,
  pendingMobileUserInput,
  requestUserInputPayloadKey,
} from '@/domain/requestUserInput'
import { runtimeTaskKey } from '@/domain/runtimeTaskLifecycle'
import type { RuntimeApi } from '@/services/runtimeApi'
import type {
  ChatMessage,
  ModelSelectionConfig,
  RequestUserInputPayload,
  RequestUserInputResponse,
  RuntimeTaskAddress,
} from '@/types/runtime'

interface MobileUserInputOptions {
  api: RuntimeApi
  currentAddress: RefObject<RuntimeTaskAddress | null>
  readMessages: (address: RuntimeTaskAddress) => ChatMessage[]
  dispatch: (address: RuntimeTaskAddress, action: ChatAction) => void
  isRunning: (address: RuntimeTaskAddress) => boolean
  modelSelection: ModelSelectionConfig | null
  onTurnStarted: (address: RuntimeTaskAddress) => void
}

export function useMobileUserInput(options: MobileUserInputOptions) {
  const inFlight = useRef(new Set<string>())
  const optionsRef = useRef(options)
  optionsRef.current = options

  const respond = useCallback(async (response: RequestUserInputResponse): Promise<boolean> => {
    const {
      api,
      currentAddress,
      readMessages,
      dispatch,
      isRunning,
      modelSelection,
      onTurnStarted,
    } = optionsRef.current
    const address = currentAddress.current
    const key = requestUserInputResponseKey(response)
    if (!address || !key) throw new Error('问题缺少有效的会话标识，请刷新会话')
    const payload = pendingMobileUserInput(readMessages(address)).get(key)
    if (!payload) throw new Error('此问题已处理或不再等待回答')
    const operationKey = `${runtimeTaskKey(address)}:${key}`
    if (inFlight.current.has(operationKey)) return false
    inFlight.current.add(operationKey)
    try {
      if (isAsyncRequestUserInputPayload(payload)) {
        const message = requestUserInputResponseText(response)
        if (isRunning(address)) {
          const result = await api.guideTask(address, message, Crypto.randomUUID())
          if (result.accepted === false || result.success === false)
            throw new Error(result.error || '回答未被执行器接受')
        } else {
          if (!modelSelection) throw new Error('请选择可用模型后重试')
          const id = Crypto.randomUUID()
          const result = await api.sendMessage(address, message, id, modelSelection)
          if (!result.accepted) throw new Error(result.error || '回答未被执行器接受')
          dispatch(address, { type: 'user-input-response', response })
          dispatch(address, {
            type: 'optimistic-user',
            id,
            content: message,
            createdAt: Date.now(),
          })
          dispatch(address, { type: 'user-delivered', id })
          onTurnStarted(address)
        }
      } else {
        const result = await api.respondToUserInput(address, response)
        if (!result.accepted) throw new Error(result.error || '回答未被执行器接受')
      }
      dispatch(address, { type: 'user-input-response', response })
      return true
    } finally {
      inFlight.current.delete(operationKey)
    }
  }, [])

  const skip = useCallback(
    async (payload: RequestUserInputPayload): Promise<boolean> => {
      const { api, currentAddress, readMessages, dispatch } = optionsRef.current
      const address = currentAddress.current
      const key = requestUserInputPayloadKey(payload)
      if (!address || !key) throw new Error('问题缺少有效的会话标识，请刷新会话')
      const current = pendingMobileUserInput(readMessages(address)).get(key)
      if (!current) throw new Error('此问题已处理或不再等待回答')
      if ((current.interactionKind ?? current.interaction_kind) === 'mcp_form') {
        return respond({
          requestId: current.requestId ?? current.request_id,
          itemId: current.itemId ?? current.item_id,
          interactionScope: current.interactionScope,
          answers: {},
        })
      }
      const operationKey = `${runtimeTaskKey(address)}:${key}`
      if (inFlight.current.has(operationKey)) return false
      inFlight.current.add(operationKey)
      const pendingKeys = [...pendingMobileUserInput(readMessages(address)).keys()]
      try {
        const result = await api.cancelTask(address)
        if (!result.accepted) throw new Error(result.error || '跳过问题失败')
        for (const pendingKey of pendingKeys)
          dispatch(address, { type: 'user-input-cancelled', key: pendingKey })
        return true
      } finally {
        inFlight.current.delete(operationKey)
      }
    },
    [respond]
  )

  return { respondToUserInput: respond, skipUserInput: skip }
}
