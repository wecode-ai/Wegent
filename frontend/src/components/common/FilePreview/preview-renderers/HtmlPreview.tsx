// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { TextPreview } from './TextPreview'
import { SandboxedHtmlFrame } from '@/components/common/SandboxedHtmlFrame'

export interface HtmlPreviewProps {
  content: string
  filename: string
  isSourceMode?: boolean
  onViewModeChange?: (isSourceMode: boolean) => void
}

export function HtmlPreview({
  content,
  filename,
  isSourceMode: controlledIsSourceMode,
  onViewModeChange,
}: HtmlPreviewProps) {
  const { t } = useTranslation('common')
  const [internalIsSourceMode, setInternalIsSourceMode] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [scriptError, setScriptError] = useState<{ message: string; line?: number } | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const isSourceMode =
    controlledIsSourceMode !== undefined ? controlledIsSourceMode : internalIsSourceMode

  const setIsSourceMode = (value: boolean) => {
    if (controlledIsSourceMode === undefined) {
      setInternalIsSourceMode(value)
    }
    onViewModeChange?.(value)
  }

  // Reset loading state when content changes
  useEffect(() => {
    setIsLoading(true)
    setHasError(false)
    setScriptError(null)
  }, [content])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return
      }
      const data = event.data as
        | { source?: string; type?: string; message?: string; line?: number }
        | undefined
      if (
        data?.source !== 'wegent-html-preview' ||
        data.type !== 'script-error' ||
        typeof data.message !== 'string'
      ) {
        return
      }
      setScriptError({ message: data.message, line: data.line })
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  const handleIframeLoad = () => setIsLoading(false)
  const handleIframeError = () => {
    setHasError(true)
    setIsLoading(false)
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <div className="flex-1 overflow-auto relative">
        {!isSourceMode ? (
          <>
            {isLoading && !hasError && (
              <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-gray-900">
                <div className="text-text-secondary">{t('actions.loading')}</div>
              </div>
            )}
            {scriptError && !isLoading && !hasError && (
              <div
                data-testid="html-preview-script-error"
                className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 border-b border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800"
              >
                <span>
                  {t('attachment.html.script_error')}
                  {scriptError.line
                    ? ` ${t('attachment.html.script_error_line', { line: scriptError.line })}`
                    : ''}
                  : {scriptError.message}
                </span>
                <button
                  type="button"
                  data-testid="html-preview-script-error-view-source"
                  onClick={() => setIsSourceMode(true)}
                  className="shrink-0 underline"
                >
                  {t('attachment.html.view_source')}
                </button>
              </div>
            )}
            {hasError && (
              <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-gray-900">
                <div className="text-center">
                  <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-2" />
                  <p className="text-text-secondary">{t('attachment.html.load_failed')}</p>
                  <button
                    type="button"
                    onClick={() => setIsSourceMode(true)}
                    className="mt-4 px-4 py-2 text-sm border border-border rounded hover:bg-surface"
                  >
                    {t('attachment.html.view_source')}
                  </button>
                </div>
              </div>
            )}
            <SandboxedHtmlFrame
              ref={frameRef}
              title={filename}
              content={content}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-popups allow-forms"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
              reportScriptErrors
              style={{ display: isLoading || hasError ? 'none' : 'block' }}
            />
          </>
        ) : (
          <TextPreview content={content} filename={filename} />
        )}
      </div>

      <div className="px-4 py-2 bg-surface dark:bg-gray-800 border-t border-border dark:border-gray-700 text-xs text-text-secondary">
        {filename} · {isSourceMode ? t('attachment.html.source_mode') : t('actions.preview')}
        <span className="ml-2 text-text-muted">
          ({new Blob([content]).size.toLocaleString()} bytes)
        </span>
      </div>
    </div>
  )
}
