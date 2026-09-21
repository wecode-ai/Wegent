'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, AlertCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { loadRFB } from './rfb-loader'
import '@wecode/i18n'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

interface VncViewerProps {
  readonly websocketUrl: string
  readonly onReconnectRequired: () => void
  readonly className?: string
}

export function VncViewer({ websocketUrl, onReconnectRequired, className = '' }: VncViewerProps) {
  const { t } = useTranslation('devices')
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rfbRef = useRef<any>(null)
  const translationRef = useRef(t)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [errorMessage, setErrorMessage] = useState<string>('')

  useEffect(() => {
    translationRef.current = t
  }, [t])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    container.replaceChildren()
    setStatus('connecting')
    setErrorMessage('')

    void (async () => {
      try {
        // Load the classic noVNC bundle only in the browser.
        const RFB = await loadRFB()
        if (disposed || containerRef.current !== container) return

        const rfb = new RFB(container, websocketUrl)
        rfb.scaleViewport = true
        rfb.resizeSession = true
        rfb.qualityLevel = 8
        rfb.compressionLevel = 2
        rfb.remoteResizePixelRatio = Math.min(window.devicePixelRatio || 1, 1.25)
        rfb.remoteResizeDebounce = 250
        rfb.enableH264 = false
        rfb.showDotCursor = true
        rfb.background = '#1a1a1a'

        rfb.addEventListener('connect', () => {
          if (!disposed) setStatus('connected')
        })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rfb.addEventListener('disconnect', (e: any) => {
          if (disposed) return
          const clean = e.detail?.clean ?? false
          if (clean) {
            setStatus('disconnected')
          } else {
            setStatus('error')
            setErrorMessage(translationRef.current('vnc_error'))
          }
        })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rfb.addEventListener('securityfailure', (e: any) => {
          if (disposed) return
          setStatus('error')
          setErrorMessage(e.detail?.reason || 'Security failure')
        })

        rfbRef.current = rfb
      } catch {
        if (!disposed) {
          setStatus('error')
          setErrorMessage(translationRef.current('vnc_error'))
        }
      }
    })()

    return () => {
      disposed = true
      const rfb = rfbRef.current
      if (rfb) {
        try {
          rfb.disconnect()
        } catch {
          // Ignore cleanup errors
        }
        if (rfbRef.current === rfb) rfbRef.current = null
      }
    }
  }, [websocketUrl])

  return (
    <div className={`absolute inset-0 flex flex-col bg-[#1a1a1a] ${className}`}>
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
                  onClick={onReconnectRequired}
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
                  onClick={onReconnectRequired}
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
