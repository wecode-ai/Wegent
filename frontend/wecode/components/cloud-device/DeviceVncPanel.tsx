// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'

import { X, Maximize2, Minimize2, ExternalLink } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'

import { CloudDeviceFilesViewer } from './CloudDeviceFilesViewer'
import { VncViewer } from './VncViewer'
import '@wecode/i18n'

interface DeviceVncPanelProps {
  readonly deviceId: string
  readonly hideFilesTab?: boolean
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
  hideFilesTab = false,
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
  const [filesUrl, setFilesUrl] = useState<string | null>(null)
  const showFilesTab = !hideFilesTab
  const credentialsText = t('vnc_files_credentials', {
    password: deviceId,
  })

  useEffect(() => {
    setFilesUrl(null)
  }, [deviceId])

  const handleFilesConfigChange = (
    config: { available: boolean; files_url?: string | null } | null
  ) => {
    if (!config?.available || !config.files_url) {
      setFilesUrl(null)
      return
    }

    setFilesUrl(config.files_url)
  }

  return (
    <div
      className={`flex flex-col overflow-hidden border-l border-border transition-[width,flex] duration-800 ease-in-out ${isFullscreen ? 'flex-1' : 'w-1/2'}`}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <h3 className="shrink-0 text-sm font-medium text-text-primary">
            {title || t('vnc_panel_title')}
          </h3>
          <div
            className="inline-flex h-8 items-center justify-center rounded-lg bg-base p-1 text-text-muted"
            role="tablist"
            aria-label={t('vnc_panel_title')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'desktop'}
              data-testid="vnc-desktop-tab"
              onClick={() => setActiveTab('desktop')}
              className={`inline-flex h-7 items-center justify-center whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-all ${
                activeTab === 'desktop'
                  ? 'bg-base text-text-primary shadow'
                  : 'text-text-secondary hover:bg-base/50 hover:text-text-primary'
              }`}
            >
              {t('vnc_desktop_tab')}
            </button>
            {showFilesTab && (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'files'}
                data-testid="vnc-files-tab"
                onClick={() => setActiveTab('files')}
                className={`inline-flex h-7 items-center justify-center whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-all ${
                  activeTab === 'files'
                    ? 'bg-base text-text-primary shadow'
                    : 'text-text-secondary hover:bg-base/50 hover:text-text-primary'
                }`}
              >
                {t('vnc_files_tab')}
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'files' && filesUrl && (
            <button
              type="button"
              onClick={() => window.open(filesUrl, '_blank', 'noopener,noreferrer')}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
              title={t('vnc_files_open_in_new_window')}
              aria-label={t('vnc_files_open_in_new_window')}
              data-testid="cloud-device-files-open-button"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
              title={
                isFullscreen
                  ? exitFullscreenLabel || 'Exit Fullscreen'
                  : fullscreenLabel || 'Fullscreen'
              }
              data-testid="vnc-fullscreen-button"
            >
              {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
            </button>
          )}
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            title={closeLabel || 'Close'}
            data-testid="vnc-close-button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {activeTab === 'files' && (
        <div
          className="shrink-0 border-b border-border bg-surface px-4 py-2"
          data-testid="cloud-device-files-credentials"
        >
          <p className="text-xs font-medium text-text-primary">{credentialsText}</p>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {activeTab === 'desktop' ? (
          <VncViewer deviceId={deviceId} />
        ) : (
          <CloudDeviceFilesViewer
            deviceId={deviceId}
            isActive
            onFileConfigChange={handleFilesConfigChange}
          />
        )}
      </div>
    </div>
  )
}

export default DeviceVncPanel
