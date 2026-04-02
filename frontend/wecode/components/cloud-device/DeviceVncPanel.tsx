// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'

import { X, Maximize2, Minimize2 } from 'lucide-react'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'

import { CloudDeviceFilesViewer } from './CloudDeviceFilesViewer'
import { VncViewer } from './VncViewer'
import '@wecode/i18n'

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
  const { t } = useTranslation('devices')
  const [activeTab, setActiveTab] = useState<'desktop' | 'files'>('desktop')

  return (
    <div
      className={`flex flex-col min-h-0 border-l border-border transition-all duration-800 ease-in-out ${isFullscreen ? 'flex-1' : 'w-1/2'}`}
    >
      <Tabs
        value={activeTab}
        onValueChange={value => setActiveTab(value as 'desktop' | 'files')}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* VNC panel header */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border bg-surface">
          <div className="flex min-w-0 items-center gap-3">
            <h3 className="shrink-0 text-sm font-medium text-text-primary">
              {title || t('vnc_panel_title')}
            </h3>
            <TabsList className="h-8 bg-base">
              <TabsTrigger
                value="desktop"
                className="h-7 px-2.5 text-xs"
                data-testid="vnc-desktop-tab"
              >
                {t('vnc_desktop_tab')}
              </TabsTrigger>
              <TabsTrigger value="files" className="h-7 px-2.5 text-xs" data-testid="vnc-files-tab">
                {t('vnc_files_tab')}
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="flex items-center gap-2">
            {/* Fullscreen toggle button */}
            {onToggleFullscreen && (
              <button
                onClick={onToggleFullscreen}
                className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-hover text-text-secondary hover:text-text-primary transition-colors"
                title={
                  isFullscreen
                    ? exitFullscreenLabel || 'Exit Fullscreen'
                    : fullscreenLabel || 'Fullscreen'
                }
                data-testid="vnc-fullscreen-button"
              >
                {isFullscreen ? (
                  <Minimize2 className="w-5 h-5" />
                ) : (
                  <Maximize2 className="w-5 h-5" />
                )}
              </button>
            )}
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-hover text-text-secondary hover:text-text-primary transition-colors"
              title={closeLabel || 'Close'}
              data-testid="vnc-close-button"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="mt-0 flex min-h-0 flex-1">
          {activeTab === 'desktop' ? (
            <VncViewer deviceId={deviceId} />
          ) : (
            <CloudDeviceFilesViewer deviceId={deviceId} isActive />
          )}
        </div>
      </Tabs>
    </div>
  )
}
