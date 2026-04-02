'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'
import { cloudDeviceApis, type CloudDeviceFileConfig } from '@wecode/apis'

import '@wecode/i18n'

interface CloudDeviceFilesViewerProps {
  readonly deviceId: string
  readonly isActive: boolean
}

type FileViewerStatus = 'idle' | 'loading' | 'ready'

export function CloudDeviceFilesViewer({ deviceId, isActive }: CloudDeviceFilesViewerProps) {
  const { t } = useTranslation('devices')
  const [status, setStatus] = useState<FileViewerStatus>('idle')
  const [fileConfig, setFileConfig] = useState<CloudDeviceFileConfig | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    requestIdRef.current += 1
    setStatus('idle')
    setFileConfig(null)
  }, [deviceId])

  useEffect(() => {
    if (!isActive || status !== 'idle') {
      return
    }

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setStatus('loading')

    cloudDeviceApis
      .getFileConfig(deviceId)
      .then(config => {
        if (requestIdRef.current === requestId) {
          setFileConfig(config)
          setStatus('ready')
        }
      })
      .catch(() => {
        if (requestIdRef.current === requestId) {
          setFileConfig({
            sandbox_id: '',
            ip_address: null,
            files_url: null,
            available: false,
          })
          setStatus('ready')
        }
      })
  }, [deviceId, isActive, status])

  if (status === 'loading') {
    return (
      <div
        className="flex flex-1 items-center justify-center bg-base"
        data-testid="cloud-device-files-loading"
      >
        <div className="text-center">
          <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-text-secondary">{t('vnc_files_loading')}</p>
        </div>
      </div>
    )
  }

  if (!fileConfig?.available || !fileConfig.files_url) {
    return (
      <div
        className="flex flex-1 items-center justify-center bg-base px-6"
        data-testid="cloud-device-files-unavailable"
      >
        <div className="max-w-sm text-center">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-text-muted" />
          <p className="text-sm font-medium text-text-primary">{t('vnc_files_unavailable')}</p>
          <p className="mt-1 text-xs text-text-secondary">{t('vnc_files_unavailable_hint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden bg-base"
      data-testid="cloud-device-files-frame"
    >
      <iframe
        title={t('vnc_files_tab')}
        src={fileConfig.files_url}
        className="absolute inset-0 block h-full w-full border-0 bg-base"
        data-testid="cloud-device-files-iframe"
      />
    </div>
  )
}

export default CloudDeviceFilesViewer
