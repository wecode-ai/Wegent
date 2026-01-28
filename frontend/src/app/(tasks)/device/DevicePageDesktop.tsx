// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Monitor, RefreshCw, MessageSquare, Trash2, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
  SearchDialog,
} from '@/features/tasks/components/sidebar'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { useSearchShortcut } from '@/features/tasks/hooks/useSearchShortcut'
import { useTranslation } from '@/hooks/useTranslation'
import { useSocket } from '@/contexts/SocketContext'
import { apiClient } from '@/apis/client'
import { cn } from '@/lib/utils'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

interface Device {
  id: number
  device_id: string
  name: string
  device_type: string
  status: 'online' | 'offline' | 'busy'
  workspace_path?: string
  last_seen_at?: string
  created_at: string
  updated_at: string
}

/**
 * Desktop-specific implementation of Device Page
 *
 * Allows users to manage and chat with their local wecode-cli instances.
 */
export default function DevicePageDesktop() {
  const { t } = useTranslation('device')
  const { socket } = useSocket()
  const router = useRouter()

  // State
  const [devices, setDevices] = useState<Device[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null)

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

  // Fetch devices
  const fetchDevices = useCallback(async () => {
    try {
      setIsLoading(true)
      const response = await apiClient.get<{ items: Device[]; total: number }>('/devices')
      setDevices(response.items)
    } catch (error) {
      console.error('Failed to fetch devices:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchDevices()
  }, [fetchDevices])

  // Listen for device status updates via WebSocket
  useEffect(() => {
    if (!socket) return

    const handleDeviceConnected = (data: Device) => {
      setDevices(prev => {
        const existing = prev.find(d => d.device_id === data.device_id)
        if (existing) {
          return prev.map(d =>
            d.device_id === data.device_id ? { ...d, ...data, status: 'online' } : d
          )
        }
        return [...prev, { ...data, status: 'online' } as Device]
      })
    }

    const handleDeviceDisconnected = (data: { device_id: string }) => {
      setDevices(prev =>
        prev.map(d => (d.device_id === data.device_id ? { ...d, status: 'offline' as const } : d))
      )
    }

    socket.on('device:connected', handleDeviceConnected)
    socket.on('device:disconnected', handleDeviceDisconnected)

    return () => {
      socket.off('device:connected', handleDeviceConnected)
      socket.off('device:disconnected', handleDeviceDisconnected)
    }
  }, [socket])

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

  const handleDeleteDevice = async (deviceId: string) => {
    try {
      await apiClient.delete(`/devices/${deviceId}`)
      setDevices(prev => prev.filter(d => d.device_id !== deviceId))
      if (selectedDevice?.device_id === deviceId) {
        setSelectedDevice(null)
      }
    } catch (error) {
      console.error('Failed to delete device:', error)
    }
  }

  // Start chat with device - navigate to device chat page
  const handleStartChat = (device: Device) => {
    router.push(`/device/chat?device_id=${device.device_id}`)
  }

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    router.push('/chat')
  }

  const getStatusIndicator = (status: Device['status']) => {
    switch (status) {
      case 'online':
        return (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-green-600">{t('status.online')}</span>
          </div>
        )
      case 'busy':
        return (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
            <span className="text-yellow-600">{t('status.busy')}</span>
          </div>
        )
      default:
        return (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="w-2 h-2 rounded-full bg-gray-400" />
            <span className="text-text-muted">{t('status.offline')}</span>
          </div>
        )
    }
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons */}
      {isCollapsed && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
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
          title={t('title')}
          onMobileSidebarToggle={() => {}}
          isSidebarCollapsed={isCollapsed}
        >
          <GithubStarButton />
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchDevices}
            disabled={isLoading}
            className="h-9 w-9"
          >
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          </Button>
        </TopNavigation>

        {/* Content area */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <RefreshCw className="h-6 w-6 animate-spin text-text-muted" />
            </div>
          ) : devices.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-4">
              <Monitor className="h-12 w-12 mb-4 text-text-muted opacity-50" />
              <h3 className="text-lg font-medium mb-2">{t('no_devices')}</h3>
              <p className="text-sm text-text-muted mb-6 text-center max-w-md">
                {t('no_devices_hint')}
              </p>
              <div className="bg-surface rounded-lg px-4 py-3 border border-border">
                <p className="text-xs text-text-muted mb-2">{t('connect_instructions')}</p>
                <code className="text-sm font-mono text-primary">{t('connect_command')}</code>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {devices.map(device => (
                <div
                  key={device.device_id}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-hover/50 transition-colors group"
                >
                  {/* Device icon */}
                  <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-surface border border-border flex items-center justify-center">
                    <Monitor className="h-5 w-5 text-primary" />
                  </div>

                  {/* Device info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{device.name}</span>
                      {getStatusIndicator(device.status)}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-text-muted">
                      {device.workspace_path && (
                        <span className="flex items-center gap-1 truncate max-w-[300px]">
                          <Terminal className="h-3 w-3 flex-shrink-0" />
                          {device.workspace_path}
                        </span>
                      )}
                      <span className="truncate">{device.device_type}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button
                      variant="default"
                      size="sm"
                      disabled={device.status !== 'online'}
                      onClick={() => handleStartChat(device)}
                      className="h-8 gap-1.5"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      {t('actions.chat')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteDevice(device.device_id)}
                      className="h-8 w-8 text-text-muted hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
