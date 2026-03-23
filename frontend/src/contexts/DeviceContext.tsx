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
  DeviceSlotUpdatePayload,
  DeviceUpgradeStatusPayload,
  ServerEvents,
} from '@/types/socket'

/** Device upgrade state */
export interface DeviceUpgradeState {
  status: string
  message: string
  progress?: number
}

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
  /** Map of device IDs to their upgrade states */
  upgradingDevices: Record<string, DeviceUpgradeState>
  /** Check if a device is currently upgrading */
  isDeviceUpgrading: (deviceId: string) => boolean
  /** Get upgrade status for a device */
  getUpgradeStatus: (deviceId: string) => DeviceUpgradeState | undefined
}

const DeviceContext = createContext<DeviceContextType | null>(null)

interface DeviceProviderProps {
  children: ReactNode
}

export function DeviceProvider({ children }: DeviceProviderProps) {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [upgradingDevices, setUpgradingDevices] = useState<Record<string, DeviceUpgradeState>>({})
  const { socket, isConnected } = useSocket()

  /**
   * Check if a device is currently upgrading.
   *
   * @param deviceId - Device unique identifier
   * @returns True if the device is upgrading
   */
  const isDeviceUpgrading = useCallback(
    (deviceId: string): boolean => {
      return !!upgradingDevices[deviceId]
    },
    [upgradingDevices]
  )

  /**
   * Get upgrade status for a device.
   *
   * @param deviceId - Device unique identifier
   * @returns Upgrade state or undefined if not upgrading
   */
  const getUpgradeStatus = useCallback(
    (deviceId: string): DeviceUpgradeState | undefined => {
      return upgradingDevices[deviceId]
    },
    [upgradingDevices]
  )

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
      setDevices(prev => {
        refreshDevices()
        const exists = prev.find(d => d.device_id === data.device_id)
        if (exists) {
          // Update status immediately for better UX while refresh is in progress
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
        return prev // Return unchanged while refresh is in progress
      })
    }

    // Device went offline - update status instead of removing
    const handleDeviceOffline = (data: DeviceOfflinePayload) => {
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
      setDevices(prev =>
        prev.map(d =>
          d.device_id === data.device_id ? { ...d, status: data.status as DeviceInfo['status'] } : d
        )
      )
    }

    // Device slot usage updated
    const handleDeviceSlotUpdate = (data: DeviceSlotUpdatePayload) => {
      setDevices(prev =>
        prev.map(d =>
          d.device_id === data.device_id
            ? {
                ...d,
                slot_used: data.slot_used,
                slot_max: data.slot_max,
                running_tasks: data.running_tasks,
              }
            : d
        )
      )
    }

    // Device upgrade status updated
    const handleDeviceUpgradeStatus = (data: DeviceUpgradeStatusPayload) => {
      setUpgradingDevices(prev => ({
        ...prev,
        [data.device_id]: {
          status: data.status,
          message: data.message,
          progress: data.progress,
        },
      }))

      // Clear state on terminal status after a delay
      // Note: We don't refresh devices here on success because the device
      // needs to restart after upgrade. The refresh will happen automatically
      // when the device comes back online via handleDeviceOnline event.
      if (['success', 'error', 'skipped'].includes(data.status)) {
        setTimeout(() => {
          setUpgradingDevices(prev => {
            const next = { ...prev }
            delete next[data.device_id]
            return next
          })
        }, 5000)
      }
    }

    // Subscribe to device events
    socket.on(ServerEvents.DEVICE_ONLINE, handleDeviceOnline)
    socket.on(ServerEvents.DEVICE_OFFLINE, handleDeviceOffline)
    socket.on(ServerEvents.DEVICE_STATUS, handleDeviceStatus)
    socket.on(ServerEvents.DEVICE_SLOT_UPDATE, handleDeviceSlotUpdate)
    socket.on(ServerEvents.DEVICE_UPGRADE_STATUS, handleDeviceUpgradeStatus)

    return () => {
      socket.off(ServerEvents.DEVICE_ONLINE, handleDeviceOnline)
      socket.off(ServerEvents.DEVICE_OFFLINE, handleDeviceOffline)
      socket.off(ServerEvents.DEVICE_STATUS, handleDeviceStatus)
      socket.off(ServerEvents.DEVICE_SLOT_UPDATE, handleDeviceSlotUpdate)
      socket.off(ServerEvents.DEVICE_UPGRADE_STATUS, handleDeviceUpgradeStatus)
    }
  }, [socket, isConnected, selectedDeviceId, refreshDevices])

  const value: DeviceContextType = {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    setDefaultDevice,
    deleteDevice,
    refreshDevices,
    isLoading,
    error,
    upgradingDevices,
    isDeviceUpgrading,
    getUpgradeStatus,
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
