// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Preview Panel Component
 *
 * Main preview panel for Workbench live preview functionality.
 * Features:
 * - Iframe-based preview of dev server
 * - Toolbar with refresh, URL bar, and viewport controls
 * - Status indicators for preview service state
 * - Responsive viewport switching
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  XMarkIcon,
  PlayIcon,
  StopIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import PreviewToolbar from './PreviewToolbar'
import type { PreviewStatus, ViewportSize } from '@/types/preview'
import { VIEWPORT_SIZES } from '@/types/preview'

interface PreviewPanelProps {
  /** Whether the panel is open */
  isOpen: boolean
  /** Preview URL */
  url: string | null
  /** Preview status */
  status: PreviewStatus
  /** Whether preview is enabled */
  enabled: boolean
  /** Current viewport size */
  viewportSize: ViewportSize
  /** Current path */
  currentPath: string
  /** Error message if any */
  error?: string | null
  /** Whether loading */
  isLoading?: boolean
  /** Task ID for preview */
  taskId?: number
  /** Callback to close panel */
  onClose: () => void
  /** Callback to start preview */
  onStart: () => void
  /** Callback to stop preview */
  onStop: () => void
  /** Callback to refresh preview */
  onRefresh: () => void
  /** Callback to change viewport */
  onViewportChange: (size: ViewportSize) => void
  /** Callback to navigate to path */
  onNavigate: (path: string) => void
}

/**
 * Status indicator component
 */
function StatusIndicator({ status }: { status: PreviewStatus }) {
  const { t } = useTranslation('tasks')

  const statusConfig = {
    disabled: {
      color: 'bg-gray-400',
      text: t('preview.status.disabled'),
    },
    starting: {
      color: 'bg-yellow-400 animate-pulse',
      text: t('preview.status.starting'),
    },
    ready: {
      color: 'bg-green-400',
      text: t('preview.status.ready'),
    },
    error: {
      color: 'bg-red-400',
      text: t('preview.status.error'),
    },
    stopped: {
      color: 'bg-gray-400',
      text: t('preview.status.stopped'),
    },
  }

  const config = statusConfig[status] || statusConfig.disabled

  return (
    <div className="flex items-center gap-2 text-sm text-text-muted">
      <span className={`w-2 h-2 rounded-full ${config.color}`} />
      <span>{config.text}</span>
    </div>
  )
}

/**
 * Empty state component when preview is not available
 */
function EmptyState({
  status,
  error,
  enabled,
  isLoading,
  onStart,
}: {
  status: PreviewStatus
  error?: string | null
  enabled: boolean
  isLoading?: boolean
  onStart: () => void
}) {
  const { t } = useTranslation('tasks')

  if (!enabled) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <ExclamationTriangleIcon className="w-12 h-12 text-text-muted mb-4" />
        <h3 className="text-lg font-medium text-text-primary mb-2">
          {t('preview.not_configured')}
        </h3>
        <p className="text-sm text-text-muted max-w-md">
          {t('preview.not_configured_desc')}
        </p>
      </div>
    )
  }

  if (status === 'error' && error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <ExclamationTriangleIcon className="w-12 h-12 text-red-500 mb-4" />
        <h3 className="text-lg font-medium text-text-primary mb-2">
          {t('preview.error_title')}
        </h3>
        <p className="text-sm text-text-muted max-w-md mb-4">{error}</p>
        <button
          onClick={onStart}
          disabled={isLoading}
          className="
            inline-flex items-center gap-2 px-4 py-2
            bg-primary text-white rounded-md
            hover:bg-primary/90 disabled:opacity-50
            transition-colors
          "
        >
          <ArrowPathIcon className="w-4 h-4" />
          {t('preview.retry')}
        </button>
      </div>
    )
  }

  if (status === 'stopped' || status === 'disabled') {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <PlayIcon className="w-12 h-12 text-text-muted mb-4" />
        <h3 className="text-lg font-medium text-text-primary mb-2">
          {t('preview.start_server')}
        </h3>
        <p className="text-sm text-text-muted max-w-md mb-4">
          {t('preview.start_server_desc')}
        </p>
        <button
          onClick={onStart}
          disabled={isLoading}
          className="
            inline-flex items-center gap-2 px-4 py-2
            bg-primary text-white rounded-md
            hover:bg-primary/90 disabled:opacity-50
            transition-colors
          "
        >
          <PlayIcon className="w-4 h-4" />
          {t('preview.start')}
        </button>
      </div>
    )
  }

  if (status === 'starting') {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent mb-4" />
        <h3 className="text-lg font-medium text-text-primary mb-2">
          {t('preview.starting')}
        </h3>
        <p className="text-sm text-text-muted">{t('preview.starting_desc')}</p>
      </div>
    )
  }

  return null
}

export default function PreviewPanel({
  isOpen,
  url,
  status,
  enabled,
  viewportSize,
  currentPath,
  error,
  isLoading = false,
  taskId,
  onClose,
  onStart,
  onStop,
  onRefresh,
  onViewportChange,
  onNavigate,
}: PreviewPanelProps) {
  const { t } = useTranslation('tasks')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeKey, setIframeKey] = useState(0)

  // Handle refresh by updating iframe key
  const handleRefresh = useCallback(() => {
    setIframeKey((prev) => prev + 1)
    onRefresh()
  }, [onRefresh])

  // Get viewport width
  const viewportWidth = VIEWPORT_SIZES[viewportSize].width

  // Determine if we should show the iframe
  const showIframe = status === 'ready' && url

  if (!isOpen) {
    return null
  }

  return (
    <div
      className="
        flex flex-col h-full
        border-l border-border bg-surface
        transition-all duration-300 ease-in-out
      "
      style={{ width: '40%', minWidth: '320px' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-text-primary">
            {t('preview.title')}
          </h3>
          <StatusIndicator status={status} />
        </div>
        <div className="flex items-center gap-2">
          {status === 'ready' && (
            <button
              onClick={onStop}
              className="
                p-1.5 rounded-md text-text-muted
                hover:text-red-500 hover:bg-red-50
                transition-colors
              "
              title={t('preview.stop')}
            >
              <StopIcon className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="
              p-1.5 rounded-md text-text-muted
              hover:text-text-primary hover:bg-muted
              transition-colors
            "
            title={t('preview.close')}
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Toolbar - only show when preview is ready */}
      {showIframe && (
        <PreviewToolbar
          currentPath={currentPath}
          viewportSize={viewportSize}
          isLoading={isLoading}
          onRefresh={handleRefresh}
          onViewportChange={onViewportChange}
          onNavigate={onNavigate}
        />
      )}

      {/* Content area */}
      <div className="flex-1 overflow-hidden bg-muted">
        {showIframe ? (
          <div
            className="h-full flex justify-center overflow-auto"
            style={{ backgroundColor: '#f0f0f0' }}
          >
            <div
              className="h-full bg-white shadow-lg transition-all duration-300"
              style={{
                width: viewportWidth,
                maxWidth: '100%',
              }}
            >
              <iframe
                key={iframeKey}
                ref={iframeRef}
                src={url}
                className="w-full h-full border-0"
                title="Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            </div>
          </div>
        ) : (
          <EmptyState
            status={status}
            error={error}
            enabled={enabled}
            isLoading={isLoading}
            onStart={onStart}
          />
        )}
      </div>
    </div>
  )
}
