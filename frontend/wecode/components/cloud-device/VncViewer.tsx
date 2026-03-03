'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Loader2, RefreshCw, AlertCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { getToken } from '@/apis/user'
import { getSocketUrl } from '@/lib/runtime-config'
import '@wecode/i18n'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

interface VncViewerProps {
  readonly deviceId: string
  readonly className?: string
}

export function VncViewer({ deviceId, className = '' }: VncViewerProps) {
  const { t } = useTranslation('devices')
  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<InstanceType<typeof import('@novnc/novnc/lib/rfb').default> | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [errorMessage, setErrorMessage] = useState<string>('')

  const connect = useCallback(async () => {
    if (!containerRef.current) return

    // Clean up previous connection
    if (rfbRef.current) {
      try {
        rfbRef.current.disconnect()
      } catch {
        // Ignore disconnect errors
      }
      rfbRef.current = null
    }

    // Clear container content
    containerRef.current.innerHTML = ''

    setStatus('connecting')
    setErrorMessage('')

    try {
      // Dynamic import for SSR safety
      const novncModule = await import('@novnc/novnc/lib/rfb')
      const RFB = novncModule.default || novncModule

      const token = getToken()
      if (!token) {
        setStatus('error')
        setErrorMessage('Authentication token not available')
        return
      }

      // Build WebSocket URL for VNC proxy
      // Two modes:
      // 1. Direct backend (npm run dev): getSocketUrl() returns backend URL like http://localhost:8000
      //    -> connect to ws://localhost:8000/api/cloud-devices/{deviceId}/vnc-ws?token=jwt
      // 2. Proxy mode (npm run dev:proxy / production): getSocketUrl() is empty
      //    -> connect to ws://current-host/vnc-proxy/{deviceId}?token=jwt (handled by server.cjs)
      const backendUrl = getSocketUrl()
      let wsUrl: string
      if (backendUrl) {
        // Direct backend mode
        const wsBase = backendUrl.replace(/^http/, 'ws')
        wsUrl = `${wsBase}/api/cloud-devices/${encodeURIComponent(deviceId)}/vnc-ws?token=${encodeURIComponent(token)}`
      } else {
        // Proxy mode (server.cjs)
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        wsUrl = `${protocol}//${window.location.host}/vnc-proxy/${encodeURIComponent(deviceId)}?token=${encodeURIComponent(token)}`
      }

      const rfb = new RFB(containerRef.current, wsUrl)
      rfb.scaleViewport = true
      rfb.resizeSession = false
      rfb.showDotCursor = true
      rfb.background = '#1a1a1a'

      rfb.addEventListener('connect', () => {
        setStatus('connected')
      })

      rfb.addEventListener('disconnect', e => {
        const clean = e.detail?.clean ?? false
        if (clean) {
          setStatus('disconnected')
        } else {
          setStatus('error')
          setErrorMessage(t('vnc_error'))
        }
        rfbRef.current = null
      })

      rfb.addEventListener('securityfailure', e => {
        setStatus('error')
        setErrorMessage(e.detail?.reason || 'Security failure')
        rfbRef.current = null
      })

      rfbRef.current = rfb
    } catch (err) {
      console.error('[VncViewer] Connection error:', err)
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : t('vnc_error'))
    }
  }, [deviceId, t])

  useEffect(() => {
    connect()

    return () => {
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect()
        } catch {
          // Ignore cleanup errors
        }
        rfbRef.current = null
      }
    }
  }, [connect])

  return (
    <div className={`relative flex flex-col flex-1 min-h-0 bg-[#1a1a1a] ${className}`}>
      {/* VNC canvas container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0"
        style={{ display: status === 'connected' ? 'block' : 'none' }}
      />

      {/* Status overlay */}
      {status !== 'connected' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
          <div className="text-center">
            {status === 'connecting' && (
              <>
                <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-3" />
                <p className="text-sm text-gray-400">{t('vnc_loading')}</p>
              </>
            )}

            {status === 'disconnected' && (
              <>
                <AlertCircle className="w-8 h-8 text-gray-500 mx-auto mb-3" />
                <p className="text-sm text-gray-400 mb-3">{t('vnc_disconnected')}</p>
                <button
                  onClick={connect}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary border border-primary/30 rounded-md hover:bg-primary/10 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('vnc_reconnect')}
                </button>
              </>
            )}

            {status === 'error' && (
              <>
                <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-3" />
                <p className="text-sm text-red-400 mb-1">{t('vnc_error')}</p>
                {errorMessage && (
                  <p className="text-xs text-gray-500 mb-3 max-w-[300px]">{errorMessage}</p>
                )}
                <button
                  onClick={connect}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary border border-primary/30 rounded-md hover:bg-primary/10 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('vnc_reconnect')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default VncViewer
