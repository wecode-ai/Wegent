// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { X, Maximize2, Minimize2 } from 'lucide-react'
import { VncViewer } from '@wecode/components/cloud-device'

interface DeviceVncPanelProps {
  readonly deviceId: string
  readonly onClose: () => void
  readonly title?: string
  readonly closeLabel?: string
  readonly isFullscreen?: boolean
  readonly onToggleFullscreen?: () => void
  readonly fullscreenLabel?: string
  readonly exitFullscreenLabel?: string
}

/**
 * VNC panel component for cloud devices
 * Displays VNC viewer with header, fullscreen toggle, and close button
 */
export function DeviceVncPanel({
  deviceId,
  onClose,
  title,
  closeLabel,
  isFullscreen = false,
  onToggleFullscreen,
  fullscreenLabel,
  exitFullscreenLabel,
}: DeviceVncPanelProps) {
  return (
    <div className={`flex flex-col min-h-0 border-l border-border transition-all duration-800 ease-in-out ${isFullscreen ? 'flex-1' : 'w-1/2'}`}>
      {/* VNC panel header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
        <h3 className="text-sm font-medium text-text-primary">{title || 'VNC Viewer'}</h3>
        <div className="flex items-center gap-2">
          {/* Fullscreen toggle button */}
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-hover text-text-secondary hover:text-text-primary transition-colors"
              title={isFullscreen ? exitFullscreenLabel || 'Exit Fullscreen' : fullscreenLabel || 'Fullscreen'}
            >
              {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
          )}
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-hover text-text-secondary hover:text-text-primary transition-colors"
            title={closeLabel || 'Close'}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
      {/* VNC viewer */}
      <VncViewer deviceId={deviceId} />
    </div>
  )
}
