// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for managing device chat via WebSocket.
 *
 * This hook handles sending messages to wecode-cli devices and
 * receiving streaming responses.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSocket } from '@/contexts/SocketContext'

export interface DeviceMessage {
  id: string
  type: 'user' | 'device'
  content: string
  timestamp: number
  status: 'pending' | 'streaming' | 'completed' | 'error'
  error?: string
}

interface UseDeviceChatOptions {
  deviceId: string | null
}

interface UseDeviceChatReturn {
  messages: DeviceMessage[]
  isConnected: boolean
  isStreaming: boolean
  sendMessage: (message: string) => Promise<void>
  clearMessages: () => void
}

export function useDeviceChat({ deviceId }: UseDeviceChatOptions): UseDeviceChatReturn {
  const { socket, isConnected } = useSocket()
  const [messages, setMessages] = useState<DeviceMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const currentRequestIdRef = useRef<string | null>(null)
  const streamingMessageIdRef = useRef<string | null>(null)

  // Handle device stream events
  useEffect(() => {
    if (!socket || !deviceId) return

    const handleStreamStart = (data: { device_id: string; request_id: string }) => {
      if (data.device_id !== deviceId) return
      console.log('[useDeviceChat] Stream started:', data.request_id)

      // Update currentRequestId to match the stream
      currentRequestIdRef.current = data.request_id
      setIsStreaming(true)

      // Create AI message placeholder
      const aiMessageId = `device-${Date.now()}`
      streamingMessageIdRef.current = aiMessageId
      setMessages(prev => [
        ...prev,
        {
          id: aiMessageId,
          type: 'device',
          content: '',
          timestamp: Date.now(),
          status: 'streaming',
        },
      ])
    }

    const handleStreamChunk = (data: {
      device_id: string
      request_id: string
      content: string
      offset: number
    }) => {
      if (data.device_id !== deviceId) return
      // Allow chunks if request_id matches (may be set by stream_start or sendMessage callback)
      if (currentRequestIdRef.current && data.request_id !== currentRequestIdRef.current) return

      console.log('[useDeviceChat] Stream chunk:', data.content?.substring(0, 30))

      // If we don't have a streaming message yet, create one (fallback if stream_start was missed)
      if (!streamingMessageIdRef.current) {
        console.log(
          '[useDeviceChat] Creating message on first chunk (stream_start may have been missed)'
        )
        const aiMessageId = `device-${Date.now()}`
        streamingMessageIdRef.current = aiMessageId
        currentRequestIdRef.current = data.request_id
        setIsStreaming(true)
        setMessages(prev => [
          ...prev,
          {
            id: aiMessageId,
            type: 'device',
            content: data.content,
            timestamp: Date.now(),
            status: 'streaming',
          },
        ])
        return
      }

      // Append content to the streaming message
      setMessages(prev =>
        prev.map(msg =>
          msg.id === streamingMessageIdRef.current
            ? { ...msg, content: msg.content + data.content }
            : msg
        )
      )
    }

    const handleStreamDone = (data: {
      device_id: string
      request_id: string
      result?: unknown
    }) => {
      if (data.device_id !== deviceId) return
      console.log('[useDeviceChat] Stream done:', data.request_id)

      setIsStreaming(false)
      currentRequestIdRef.current = null

      // Mark message as completed
      setMessages(prev =>
        prev.map(msg =>
          msg.id === streamingMessageIdRef.current ? { ...msg, status: 'completed' } : msg
        )
      )
      streamingMessageIdRef.current = null
    }

    const handleStreamError = (data: { device_id: string; request_id: string; error: string }) => {
      if (data.device_id !== deviceId) return
      console.error('[useDeviceChat] Stream error:', data.error)

      setIsStreaming(false)
      currentRequestIdRef.current = null

      // Mark message as error
      setMessages(prev =>
        prev.map(msg =>
          msg.id === streamingMessageIdRef.current
            ? { ...msg, status: 'error', error: data.error }
            : msg
        )
      )
      streamingMessageIdRef.current = null
    }

    // Register event listeners
    console.log(
      '[useDeviceChat] Registering socket event listeners, socket connected:',
      socket.connected
    )

    socket.onAny((eventName, ...args) => {
      if (eventName.startsWith('device:')) {
        console.log(`[useDeviceChat] onAny: ${eventName}`, args)
      }
    })

    socket.on('device:stream_start', handleStreamStart)
    socket.on('device:stream_chunk', handleStreamChunk)
    socket.on('device:stream_done', handleStreamDone)
    socket.on('device:stream_error', handleStreamError)

    return () => {
      socket.off('device:stream_start', handleStreamStart)
      socket.off('device:stream_chunk', handleStreamChunk)
      socket.off('device:stream_done', handleStreamDone)
      socket.off('device:stream_error', handleStreamError)
    }
  }, [socket, deviceId])

  // Send message to device
  const sendMessage = useCallback(
    async (message: string) => {
      if (!socket || !deviceId || !isConnected) {
        throw new Error('Not connected to server')
      }

      // Add user message immediately
      const userMessageId = `user-${Date.now()}`
      setMessages(prev => [
        ...prev,
        {
          id: userMessageId,
          type: 'user',
          content: message,
          timestamp: Date.now(),
          status: 'completed',
        },
      ])

      // Send to server
      return new Promise<void>((resolve, reject) => {
        socket.emit(
          'device:send_message',
          {
            device_id: deviceId,
            message,
          },
          (response: { success?: boolean; request_id?: string; error?: string }) => {
            if (response?.error) {
              console.error('[useDeviceChat] Send error:', response.error)
              // Update user message to show error
              setMessages(prev =>
                prev.map(msg =>
                  msg.id === userMessageId
                    ? { ...msg, status: 'error', error: response.error }
                    : msg
                )
              )
              reject(new Error(response.error))
            } else if (response?.request_id) {
              console.log('[useDeviceChat] Message sent, request_id:', response.request_id)
              currentRequestIdRef.current = response.request_id
              resolve()
            } else {
              reject(new Error('No response from server'))
            }
          }
        )
      })
    },
    [socket, deviceId, isConnected]
  )

  // Clear messages
  const clearMessages = useCallback(() => {
    setMessages([])
  }, [])

  return {
    messages,
    isConnected,
    isStreaming,
    sendMessage,
    clearMessages,
  }
}
