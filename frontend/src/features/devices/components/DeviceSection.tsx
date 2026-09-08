// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Device section component.
 * Reusable section for displaying local or cloud devices with header and grid.
 */

'use client'

import { LucideIcon } from 'lucide-react'
import { DeviceInfo } from '@/apis/devices'

export interface DeviceSectionProps {
  title: string
  icon: LucideIcon
  devices: DeviceInfo[]
  emptyMessage: string
  type?: DeviceInfo['device_type'] | DeviceInfo['device_type'][]
  children: (device: DeviceInfo) => React.ReactNode
}

/**
 * Reusable device section with header and grid layout.
 *
 * Features:
 * - Section header with icon, title, and device count
 * - Device grid using render prop pattern
 * - Optional device type filtering
 * - Empty state placeholder when no devices
 *
 * Usage:
 * ```tsx
 * <DeviceSection
 *   title="Local Devices"
 *   icon={Monitor}
 *   devices={allDevices}
 *   type="local"
 *   emptyMessage="No local devices"
 * >
 *   {device => <DeviceCard device={device} ... />}
 * </DeviceSection>
 * ```
 */
export function DeviceSection({
  title,
  icon: Icon,
  devices,
  emptyMessage,
  type,
  children,
}: DeviceSectionProps) {
  // Filter devices by type if specified
  const types = type ? (Array.isArray(type) ? type : [type]) : null
  const filteredDevices = types
    ? devices.filter(device => {
        const dt = device.device_type || 'local'
        return types.includes(dt)
      })
    : devices
  const testId = types ? `device-section-${types[0]}` : undefined

  return (
    <div data-testid={testId}>
      {/* Section header */}
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-5 h-5 text-text-secondary" />
        <h3 className="text-sm font-medium text-text-secondary">{title}</h3>
        <span className="text-xs text-text-muted">({filteredDevices.length})</span>
      </div>

      {/* Device grid or empty placeholder */}
      {filteredDevices.length > 0 ? (
        <div className="grid gap-4">
          {filteredDevices.map(device => (
            <div key={device.id}>{children(device)}</div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-text-muted py-4 text-center border border-dashed border-border rounded-lg">
          {emptyMessage}
        </div>
      )}
    </div>
  )
}
