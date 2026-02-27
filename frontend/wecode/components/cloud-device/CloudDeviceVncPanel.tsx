// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { XMarkIcon, ComputerDesktopIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import '@wecode/i18n'

interface CloudDeviceVncPanelProps {
  vncUrl: string
  isOpen: boolean
  onClose: () => void
  deviceName?: string
}

export function CloudDeviceVncPanel({
  vncUrl,
  isOpen,
  onClose,
  deviceName,
}: CloudDeviceVncPanelProps) {
  const { t } = useTranslation('devices')
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)

  const handleIframeLoad = () => {
    setIsLoading(false)
  }

  const handleIframeError = () => {
    setIsLoading(false)
    setHasError(true)
  }

  return (
    <div
      className="transition-all duration-300 ease-in-out bg-surface overflow-hidden"
      style={{
        width: isOpen ? '70%' : '0',
      }}
    >
      {isOpen && (
        <div className="h-full flex flex-col border border-border rounded-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/90 backdrop-blur-sm">
            <div className="flex items-center gap-1.5">
              <ComputerDesktopIcon className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium text-text-primary truncate">
                {deviceName || t('vnc_title')}
              </span>
            </div>
            <button
              onClick={onClose}
              className="rounded-full p-0.5 text-text-muted hover:text-text-primary hover:bg-muted focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-primary"
              title={t('vnc_close')}
            >
              <span className="sr-only">{t('vnc_close')}</span>
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 relative bg-black">
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface z-10">
                <div className="flex flex-col items-center gap-3">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                  <p className="text-sm text-text-muted">{t('vnc_loading')}</p>
                </div>
              </div>
            )}

            {hasError ? (
              <div className="absolute inset-0 flex items-center justify-center bg-surface">
                <div className="text-center px-4">
                  <ComputerDesktopIcon className="h-12 w-12 text-text-muted mx-auto mb-3" />
                  <p className="text-text-muted">{t('vnc_error')}</p>
                  <p className="text-xs text-text-tertiary mt-2 break-all max-w-md">{vncUrl}</p>
                </div>
              </div>
            ) : (
              <iframe
                src={vncUrl}
                title={deviceName || t('vnc_title')}
                className="w-full h-full border-0"
                onLoad={handleIframeLoad}
                onError={handleIframeError}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                allow="clipboard-read; clipboard-write"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default CloudDeviceVncPanel
