// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useRef, useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { TextPreview } from './TextPreview'

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

  const isSourceMode =
    controlledIsSourceMode !== undefined ? controlledIsSourceMode : internalIsSourceMode

  const setIsSourceMode = (value: boolean) => {
    if (controlledIsSourceMode === undefined) {
      setInternalIsSourceMode(value)
    }
    onViewModeChange?.(value)
  }

  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Reset loading state when content changes
  useEffect(() => {
    setIsLoading(true)
    setHasError(false)
  }, [content])

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
            <iframe
              ref={iframeRef}
              title={filename}
              srcDoc={content}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-popups allow-forms"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
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
