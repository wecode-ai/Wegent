// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Device Context Provider
 *
 * Manages local device state and real-time updates via WebSocket.
 * Provides device list and selection functionality for chat input.
 *
 * Devices are stored as Device CRD in the backend kinds table.
 * Online status is managed via Redis with heartbeat mechanism.
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from 'react'
import { useSocket } from './SocketContext'
import { deviceApis, DeviceInfo } from '@/apis/devices'
import {
  DeviceOnlinePayload,
  DeviceOfflinePayload,
  DeviceStatusPayload,
  ServerEvents,
} from '@/types/socket'

interface DeviceContextType {
  /** List of all devices (including offline) */
  devices: DeviceInfo[]
  /** Currently selected device ID (null = cloud executor) */
  selectedDeviceId: string | null
  /** Set selected device ID */
  setSelectedDeviceId: (id: string | null) => void
  /** Set a device as the default executor */
  setDefaultDevice: (deviceId: string) => Promise<void>
  /** Delete a device registration */
  deleteDevice: (deviceId: string) => Promise<void>
  /** Refresh device list from server */
  refreshDevices: () => Promise<void>
  /** Loading state */
  isLoading: boolean
  /** Error message if any */
  error: string | null
}

const DeviceContext = createContext<DeviceContextType | null>(null)

interface DeviceProviderProps {
  children: ReactNode
}

export function DeviceProvider({ children }: DeviceProviderProps) {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { socket, isConnected } = useSocket()

  // Fetch all devices (including offline)
  const refreshDevices = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await deviceApis.getAllDevices()
      setDevices(response.items || [])
    } catch (err) {
      console.error('[DeviceContext] Failed to fetch devices:', err)
      setError('Failed to load devices')
      setDevices([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Set a device as the default executor
  const setDefaultDevice = useCallback(async (deviceId: string) => {
    try {
      await deviceApis.setDefaultDevice(deviceId)
      // Update local state
      setDevices(prev =>
        prev.map(d => ({
          ...d,
          is_default: d.device_id === deviceId,
        }))
      )
    } catch (err) {
      console.error('[DeviceContext] Failed to set default device:', err)
      throw err
    }
  }, [])

  // Delete a device registration
  const deleteDevice = useCallback(
    async (deviceId: string) => {
      try {
        await deviceApis.deleteDevice(deviceId)
        // Update local state
        setDevices(prev => prev.filter(d => d.device_id !== deviceId))
        // Clear selection if deleted device was selected
        if (selectedDeviceId === deviceId) {
          setSelectedDeviceId(null)
        }
      } catch (err) {
        console.error('[DeviceContext] Failed to delete device:', err)
        throw err
      }
    },
    [selectedDeviceId]
  )

  // Load devices on mount
  useEffect(() => {
    refreshDevices()
  }, [refreshDevices])

  // Handle real-time device events via WebSocket
  useEffect(() => {
    if (!socket || !isConnected) return

    // Device came online
    const handleDeviceOnline = (data: DeviceOnlinePayload) => {
      console.log('[DeviceContext] device:online', data)
      setDevices(prev => {
        const exists = prev.find(d => d.device_id === data.device_id)
        if (exists) {
          // Update existing device status to online
          return prev.map(d =>
            d.device_id === data.device_id
              ? {
                  ...d,
                  status: data.status as DeviceInfo['status'],
                  name: data.name,
                }
              : d
          )
        }
        // Add new device (this shouldn't happen often since devices are persisted)
        return [
          ...prev,
          {
            id: 0, // Will be refreshed on next fetch
            device_id: data.device_id,
            name: data.name,
            status: data.status as DeviceInfo['status'],
            is_default: false,
          },
        ]
      })
    }

    // Device went offline - update status instead of removing
    const handleDeviceOffline = (data: DeviceOfflinePayload) => {
      console.log('[DeviceContext] device:offline', data)
      setDevices(prev =>
        prev.map(d => (d.device_id === data.device_id ? { ...d, status: 'offline' } : d))
      )
      // Clear selection if selected device went offline
      if (selectedDeviceId === data.device_id) {
        setSelectedDeviceId(null)
      }
    }

    // Device status changed (online/busy)
    const handleDeviceStatus = (data: DeviceStatusPayload) => {
      console.log('[DeviceContext] device:status', data)
      setDevices(prev =>
        prev.map(d =>
          d.device_id === data.device_id ? { ...d, status: data.status as DeviceInfo['status'] } : d
        )
      )
    }

    // Subscribe to device events
    socket.on(ServerEvents.DEVICE_ONLINE, handleDeviceOnline)
    socket.on(ServerEvents.DEVICE_OFFLINE, handleDeviceOffline)
    socket.on(ServerEvents.DEVICE_STATUS, handleDeviceStatus)

    return () => {
      socket.off(ServerEvents.DEVICE_ONLINE, handleDeviceOnline)
      socket.off(ServerEvents.DEVICE_OFFLINE, handleDeviceOffline)
      socket.off(ServerEvents.DEVICE_STATUS, handleDeviceStatus)
    }
  }, [socket, isConnected, selectedDeviceId])

  const value: DeviceContextType = {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    setDefaultDevice,
    deleteDevice,
    refreshDevices,
    isLoading,
    error,
  }

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>
}

/**
 * Hook to use device context.
 * Must be used within a DeviceProvider.
 */
export function useDevices() {
  const context = useContext(DeviceContext)
  if (!context) {
    throw new Error('useDevices must be used within a DeviceProvider')
  }
  return context
}
