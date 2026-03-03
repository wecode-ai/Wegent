// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { X } from 'lucide-react'
import { VncViewer } from '@wecode/components/cloud-device'

interface DeviceVncPanelProps {
  readonly deviceId: string
  readonly onClose: () => void
  readonly title?: string
  readonly closeLabel?: string
}

/**
 * VNC panel component for cloud devices
 * Displays VNC viewer with header and close button
 */
export function DeviceVncPanel({ deviceId, onClose, title, closeLabel }: DeviceVncPanelProps) {
  return (
    <div className="w-1/2 flex flex-col min-h-0 border-l border-border">
      {/* VNC panel header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
        <h3 className="text-sm font-medium text-text-primary">{title || 'VNC Viewer'}</h3>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-hover text-text-muted hover:text-text-primary transition-colors"
          title={closeLabel || 'Close'}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {/* VNC viewer */}
      <VncViewer deviceId={deviceId} />
    </div>
  )
}
