// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Monitor,
  RefreshCw,
  MessageSquare,
  Trash2,
  Terminal,
  Wifi,
  WifiOff,
  Menu,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import MobileSidebar from '@/features/layout/MobileSidebar'
import { TaskSidebar } from '@/features/tasks/components/sidebar'
import { useTranslation } from '@/hooks/useTranslation'
import { useSocket } from '@/contexts/SocketContext'
import { apiClient } from '@/apis/client'

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
 * Mobile-specific implementation of Device Page
 */
export default function DevicePageMobile() {
  const { t } = useTranslation('device')
  const { socket } = useSocket()
  const router = useRouter()

  // State
  const [devices, setDevices] = useState<Device[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

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

  const handleDeleteDevice = async (deviceId: string) => {
    try {
      await apiClient.delete(`/devices/${deviceId}`)
      setDevices(prev => prev.filter(d => d.device_id !== deviceId))
    } catch (error) {
      console.error('Failed to delete device:', error)
    }
  }

  // Start chat with device - navigate to device chat page
  const handleStartChat = (device: Device) => {
    router.push(`/device/chat?device_id=${device.device_id}`)
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

  return (
    <div className="flex flex-col h-screen bg-base text-text-primary">
      {/* Mobile Sidebar */}
      <MobileSidebar isOpen={isMobileSidebarOpen} onClose={() => setIsMobileSidebarOpen(false)}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="device"
        />
      </MobileSidebar>

      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setIsMobileSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">{t('title')}</h1>
        </div>
        <Button variant="ghost" size="icon" onClick={fetchDevices} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </header>

      {/* Content area */}
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-4">
          {/* Devices list */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-6 w-6 animate-spin text-text-muted" />
            </div>
          ) : devices.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <Monitor className="h-10 w-10 mx-auto mb-3 text-text-muted" />
                <h3 className="text-base font-medium mb-2">{t('no_devices')}</h3>
                <p className="text-sm text-text-muted mb-4">{t('no_devices_hint')}</p>
                <div className="bg-surface rounded-lg p-3 inline-block">
                  <p className="text-xs text-text-muted mb-1">{t('connect_instructions')}</p>
                  <code className="bg-base px-2 py-1 rounded text-xs font-mono">
                    {t('connect_command')}
                  </code>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {devices.map(device => (
                <Card key={device.device_id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Monitor className="h-4 w-4 text-primary" />
                        <div>
                          <CardTitle className="text-sm">{device.name}</CardTitle>
                          <CardDescription className="text-xs truncate max-w-[150px]">
                            {device.device_id}
                          </CardDescription>
                        </div>
                      </div>
                      {getStatusBadge(device.status)}
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="space-y-2">
                      {device.workspace_path && (
                        <div className="flex items-center gap-2 text-xs text-text-muted truncate">
                          <Terminal className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{device.workspace_path}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2 pt-2">
                        <Button
                          variant="default"
                          size="sm"
                          disabled={device.status !== 'online'}
                          className="flex-1 h-10"
                          onClick={() => handleStartChat(device)}
                        >
                          <MessageSquare className="h-4 w-4 mr-2" />
                          {t('actions.chat')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-10 w-10"
                          onClick={() => handleDeleteDevice(device.device_id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
