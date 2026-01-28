// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Device Chat Page - Chat interface for communicating with wecode-cli devices.
 *
 * This page is opened when user clicks "Start Chat" on a device in the device list.
 * It uses WebSocket to send messages to the local CLI and receive streaming responses.
 * Layout is consistent with the main chat page.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Send, Loader2, Monitor, AlertCircle, Wifi, WifiOff, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { useDeviceChat, DeviceMessage } from '@/features/device/hooks/useDeviceChat'
import { apiClient } from '@/apis/client'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
  SearchDialog,
} from '@/features/tasks/components/sidebar'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'

interface Device {
  id: number
  device_id: string
  name: string
  device_type: string
  status: 'online' | 'offline' | 'busy'
  workspace_path?: string
}

/**
 * Device Chat Page Component
 */
export default function DeviceChatPage() {
  const { t } = useTranslation('device')
  const router = useRouter()
  const searchParams = useSearchParams()
  const deviceId = searchParams.get('device_id')

  // Device info
  const [device, setDevice] = useState<Device | null>(null)
  const [isLoadingDevice, setIsLoadingDevice] = useState(true)

  // Chat state
  const { messages, isConnected, isStreaming, sendMessage } = useDeviceChat({
    deviceId,
  })

  // Input state
  const [inputValue, setInputValue] = useState('')
  const [isSending, setIsSending] = useState(false)

  // Sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false)

  // Toggle search dialog callback
  const toggleSearchDialog = useCallback(() => {
    setIsSearchDialogOpen(prev => !prev)
  }, [])

  // Global search shortcut hook
  const { shortcutDisplayText } = useSearchShortcut({
    onToggle: toggleSearchDialog,
  })

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed')
    if (savedCollapsed === 'true') {
      setIsCollapsed(true)
    }
  }, [])

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev
      localStorage.setItem('task-sidebar-collapsed', String(newValue))
      return newValue
    })
  }

  // Fetch device info
  useEffect(() => {
    if (!deviceId) {
      setIsLoadingDevice(false)
      return
    }

    const fetchDevice = async () => {
      try {
        const response = await apiClient.get<{ items: Device[] }>('/devices')
        const foundDevice = response.items.find(d => d.device_id === deviceId)
        setDevice(foundDevice || null)
      } catch (error) {
        console.error('Failed to fetch device:', error)
      } finally {
        setIsLoadingDevice(false)
      }
    }

    fetchDevice()
  }, [deviceId])

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Handle send
  const handleSend = useCallback(async () => {
    const message = inputValue.trim()
    if (!message || isSending || isStreaming) return

    setIsSending(true)
    setInputValue('')

    try {
      await sendMessage(message)
    } catch (error) {
      console.error('Failed to send message:', error)
    } finally {
      setIsSending(false)
    }
  }, [inputValue, isSending, isStreaming, sendMessage])

  // Handle key press
  const handleKeyPress = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  // Render message content
  const renderMessageContent = (message: DeviceMessage) => {
    if (message.status === 'streaming' && !message.content) {
      return (
        <div className="flex items-center gap-2 text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('chat.thinking')}</span>
        </div>
      )
    }

    return (
      <div className="whitespace-pre-wrap break-words">
        {message.content}
        {message.status === 'streaming' && (
          <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1" />
        )}
      </div>
    )
  }

  const getStatusBadge = (status: Device['status']) => {
    switch (status) {
      case 'online':
        return (
          <Badge variant="default" className="bg-green-500">
            <Wifi className="w-3 h-3 mr-1" />
            {t('status.online')}
          </Badge>
        )
      case 'busy':
        return (
          <Badge variant="secondary" className="bg-yellow-500 text-white">
            <Wifi className="w-3 h-3 mr-1" />
            {t('status.busy')}
          </Badge>
        )
      default:
        return (
          <Badge variant="info" className="text-text-muted">
            <WifiOff className="w-3 h-3 mr-1" />
            {t('status.offline')}
          </Badge>
        )
    }
  }

  // Render loading state
  if (isLoadingDevice) {
    return (
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {isCollapsed && (
          <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={() => {}} />
        )}
        <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
          <TaskSidebar
            isMobileSidebarOpen={false}
            setIsMobileSidebarOpen={() => {}}
            pageType="device"
            isCollapsed={isCollapsed}
            onToggleCollapsed={handleToggleCollapsed}
            isSearchDialogOpen={isSearchDialogOpen}
            onSearchDialogOpenChange={setIsSearchDialogOpen}
            shortcutDisplayText={shortcutDisplayText}
          />
        </ResizableSidebar>
        <div className="flex-1 flex flex-col min-w-0">
          <TopNavigation
            activePage="device"
            variant="with-sidebar"
            title={t('chat.title')}
            onMobileSidebarToggle={() => {}}
            isSidebarCollapsed={isCollapsed}
          >
            <GithubStarButton />
          </TopNavigation>
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        </div>
      </div>
    )
  }

  // No device ID or device not found/offline
  if (!deviceId || !device || device.status === 'offline') {
    return (
      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        {isCollapsed && (
          <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={() => {}} />
        )}
        <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
          <TaskSidebar
            isMobileSidebarOpen={false}
            setIsMobileSidebarOpen={() => {}}
            pageType="device"
            isCollapsed={isCollapsed}
            onToggleCollapsed={handleToggleCollapsed}
            isSearchDialogOpen={isSearchDialogOpen}
            onSearchDialogOpenChange={setIsSearchDialogOpen}
            shortcutDisplayText={shortcutDisplayText}
          />
        </ResizableSidebar>
        <div className="flex-1 flex flex-col min-w-0">
          <TopNavigation
            activePage="device"
            variant="with-sidebar"
            title={t('chat.title')}
            onMobileSidebarToggle={() => {}}
            isSidebarCollapsed={isCollapsed}
          >
            <GithubStarButton />
          </TopNavigation>
          <div className="flex-1 flex flex-col items-center justify-center p-4">
            {!deviceId ? (
              <>
                <AlertCircle className="h-12 w-12 text-text-muted mb-4" />
                <h2 className="text-lg font-medium mb-2">{t('chat.no_device')}</h2>
              </>
            ) : (
              <>
                <Monitor className="h-12 w-12 text-text-muted mb-4" />
                <h2 className="text-lg font-medium mb-2">
                  {device ? t('chat.device_offline') : t('chat.device_not_found')}
                </h2>
                <p className="text-text-muted mb-4 text-center">
                  {device ? t('chat.device_offline_hint') : t('chat.device_not_found_hint')}
                </p>
              </>
            )}
            <Button variant="outline" onClick={() => router.push('/device')}>
              {t('chat.back_to_devices')}
            </Button>
          </div>
        </div>
        <SearchDialog
          open={isSearchDialogOpen}
          onOpenChange={setIsSearchDialogOpen}
          shortcutDisplayText={shortcutDisplayText}
          pageType="device"
        />
      </div>
    )
  }

  // Build title with device info
  const chatTitle = device.name

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons */}
      {isCollapsed && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={() => {}} />
      )}

      {/* Responsive resizable sidebar */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={false}
          setIsMobileSidebarOpen={() => {}}
          pageType="device"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
          isSearchDialogOpen={isSearchDialogOpen}
          onSearchDialogOpenChange={setIsSearchDialogOpen}
          shortcutDisplayText={shortcutDisplayText}
        />
      </ResizableSidebar>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation */}
        <TopNavigation
          activePage="device"
          variant="with-sidebar"
          title={chatTitle}
          onMobileSidebarToggle={() => {}}
          isSidebarCollapsed={isCollapsed}
        >
          {/* Device status badge */}
          {getStatusBadge(device.status)}
          {/* Connection status */}
          {!isConnected && (
            <Badge variant="error" className="flex-shrink-0">
              {t('chat.disconnected')}
            </Badge>
          )}
          <GithubStarButton />
        </TopNavigation>

        {/* Device info bar */}
        {device.workspace_path && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface text-sm text-text-muted">
            <Terminal className="h-4 w-4" />
            <span className="truncate">{device.workspace_path}</span>
          </div>
        )}

        {/* Messages area */}
        <div className="flex-1 overflow-auto p-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-text-muted">
              <Monitor className="h-12 w-12 mb-4 opacity-50" />
              <p>{t('chat.start_conversation')}</p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-4">
              {messages.map(message => (
                <div
                  key={message.id}
                  className={cn('flex', message.type === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <Card
                    className={cn(
                      'max-w-[80%]',
                      message.type === 'user' ? 'bg-primary text-white' : 'bg-surface',
                      message.status === 'error' && 'border-destructive'
                    )}
                  >
                    <CardContent className="p-3">
                      {renderMessageContent(message)}
                      {message.status === 'error' && message.error && (
                        <p className="text-xs text-destructive mt-2">{message.error}</p>
                      )}
                    </CardContent>
                  </Card>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="border-t border-border bg-surface p-4">
          <div className="max-w-3xl mx-auto flex gap-2">
            <Textarea
              ref={textareaRef}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder={t('chat.input_placeholder')}
              className="resize-none min-h-[44px] max-h-32"
              disabled={!isConnected || isSending || isStreaming}
              rows={1}
            />
            <Button
              onClick={handleSend}
              disabled={!inputValue.trim() || !isConnected || isSending || isStreaming}
              className="h-11 w-11 flex-shrink-0"
            >
              {isSending || isStreaming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Search Dialog */}
      <SearchDialog
        open={isSearchDialogOpen}
        onOpenChange={setIsSearchDialogOpen}
        shortcutDisplayText={shortcutDisplayText}
        pageType="device"
      />
    </div>
  )
}
