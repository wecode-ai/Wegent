// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'

import {
  AlertCircle,
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
} from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { cloudDeviceApis, validatedVncSessionUrl } from '@wecode/apis'

import { CloudDeviceFilesViewer } from './CloudDeviceFilesViewer'
import { VncViewer } from './VncViewer'
import '@wecode/i18n'

interface DeviceVncPanelProps {
  readonly deviceId: string
  readonly ownerUserId?: number
  readonly hideFilesTab?: boolean
  readonly onClose: () => void
  readonly title?: string
  readonly closeLabel?: string
  readonly isFullscreen?: boolean
  readonly onToggleFullscreen?: () => void
  readonly fullscreenLabel?: string
  readonly exitFullscreenLabel?: string
  readonly containerClassName?: string
  readonly borderPosition?: 'left' | 'top'
}

type VncSessionState =
  | { status: 'loading' }
  | { status: 'ready'; websocketUrl: string }
  | { status: 'error'; message: string }

/**
 * VNC panel component for cloud devices
 * Displays VNC viewer with header, fullscreen toggle, and close button
 */
export function DeviceVncPanel({
  deviceId,
  ownerUserId,
  hideFilesTab = false,
  onClose,
  title,
  closeLabel,
  isFullscreen = false,
  onToggleFullscreen,
  fullscreenLabel,
  exitFullscreenLabel,
  containerClassName,
  borderPosition = 'left',
}: DeviceVncPanelProps) {
  const { t } = useTranslation('devices')
  const [activeTab, setActiveTab] = useState<'desktop' | 'files'>('desktop')
  const [filesUrl, setFilesUrl] = useState<string | null>(null)
  const [vncAttempt, setVncAttempt] = useState(0)
  const [vncSession, setVncSession] = useState<VncSessionState>({ status: 'loading' })
  const showFilesTab = !hideFilesTab
  const credentialsText = t('vnc_files_credentials', {
    password: deviceId,
  })

  useEffect(() => {
    setFilesUrl(null)
  }, [deviceId])

  useEffect(() => {
    if (activeTab !== 'desktop') return
    let active = true
    let sessionId: string | null = null
    setVncSession({ status: 'loading' })

    void (async () => {
      try {
        const session = await cloudDeviceApis.startVncSession(deviceId, ownerUserId)
        let websocketUrl: string
        try {
          websocketUrl = validatedVncSessionUrl(session)
        } catch (error) {
          await cloudDeviceApis.revokeVncSession(session.session_id).catch(() => undefined)
          throw error
        }
        if (!active) {
          await cloudDeviceApis.revokeVncSession(session.session_id).catch(() => undefined)
          return
        }
        sessionId = session.session_id
        setVncSession({ status: 'ready', websocketUrl })
      } catch (error) {
        if (!active) return
        setVncSession({
          status: 'error',
          message: error instanceof Error ? error.message : 'VNC session failed',
        })
      }
    })()

    return () => {
      active = false
      if (sessionId) {
        void cloudDeviceApis.revokeVncSession(sessionId).catch(() => undefined)
      }
    }
  }, [activeTab, deviceId, ownerUserId, vncAttempt])

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
      className={cn(
        'flex flex-col overflow-hidden border-border transition-[width,flex] duration-800 ease-in-out',
        borderPosition === 'top' ? 'border-t' : 'border-l',
        containerClassName ?? (isFullscreen ? 'flex-1' : 'w-1/2')
      )}
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
          vncSession.status === 'ready' ? (
            <VncViewer
              websocketUrl={vncSession.websocketUrl}
              onReconnectRequired={() => setVncAttempt(current => current + 1)}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
              {vncSession.status === 'loading' ? (
                <div className="text-center" data-testid="vnc-session-loading">
                  <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
                  <p className="text-sm text-gray-400">{t('vnc_loading')}</p>
                </div>
              ) : (
                <div className="text-center" data-testid="vnc-session-error">
                  <AlertCircle className="mx-auto mb-3 h-8 w-8 text-red-400" />
                  <p className="mb-1 text-sm text-red-400">{t('vnc_error')}</p>
                  <p className="mb-3 max-w-[300px] text-xs text-gray-500">{vncSession.message}</p>
                  <button
                    type="button"
                    onClick={() => setVncAttempt(current => current + 1)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 px-3 py-1.5 text-sm text-primary transition-colors hover:bg-primary/10"
                    data-testid="vnc-session-retry"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('vnc_reconnect')}
                  </button>
                </div>
              )}
            </div>
          )
        ) : (
          <CloudDeviceFilesViewer
            deviceId={deviceId}
            ownerUserId={ownerUserId}
            isActive
            onFileConfigChange={handleFilesConfigChange}
          />
        )}
      </div>
    </div>
  )
}

export default DeviceVncPanel
