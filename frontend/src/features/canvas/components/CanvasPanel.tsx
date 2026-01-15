// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback } from 'react'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  CheckIcon,
  ArrowDownTrayIcon,
  XMarkIcon,
  ArrowsPointingOutIcon,
  ArrowsPointingInIcon,
  ClockIcon,
} from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import type { Artifact } from '../types'

function classNames(...classes: string[]) {
  return classes.filter(Boolean).join(' ')
}

interface CanvasPanelProps {
  artifact: Artifact | null
  isLoading?: boolean
  onClose?: () => void
  onArtifactUpdate?: (artifact: Artifact) => void
  onQuickAction?: (actionId: string, optionValue?: string) => void
  onVersionRevert?: (version: number) => void
  className?: string
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
}

export function CanvasPanel({
  artifact,
  isLoading = false,
  onClose,
  onArtifactUpdate: _onArtifactUpdate,
  onQuickAction: _onQuickAction,
  onVersionRevert,
  className,
  isFullscreen = false,
  onToggleFullscreen,
}: CanvasPanelProps) {
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState<'content' | 'versions'>('content')

  // Copy content to clipboard
  const handleCopy = useCallback(async () => {
    if (!artifact?.content) return
    try {
      await navigator.clipboard.writeText(artifact.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [artifact?.content])

  // Download content
  const handleDownload = useCallback(() => {
    if (!artifact) return

    const extension = artifact.artifact_type === 'code' ? artifact.language || 'txt' : 'md'
    const filename = `${artifact.title || 'artifact'}.${extension}`
    const blob = new Blob([artifact.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [artifact])

  // Navigate version
  const handleVersionNav = useCallback(
    (direction: 'prev' | 'next') => {
      if (!artifact || !onVersionRevert) return
      const targetVersion =
        direction === 'prev' ? artifact.version - 1 : artifact.version + 1
      if (targetVersion >= 1 && targetVersion <= artifact.versions.length) {
        onVersionRevert(targetVersion)
      }
    },
    [artifact, onVersionRevert]
  )

  // Empty state
  if (!artifact && !isLoading) {
    return (
      <div
        className={cn(
          'h-full flex flex-col border-l border-border overflow-hidden bg-surface',
          isFullscreen && 'fixed inset-0 z-50',
          className
        )}
      >
        {/* Minimal header */}
        <div className="flex items-center justify-between h-10 px-3 border-b border-border flex-shrink-0">
          <span className="text-sm font-medium text-text-primary">Canvas</span>
          <div className="flex items-center gap-1">
            {onToggleFullscreen && (
              <button
                onClick={onToggleFullscreen}
                className="p-1 text-text-muted hover:text-text-primary"
                title={isFullscreen ? '退出全屏' : '全屏'}
              >
                {isFullscreen ? (
                  <ArrowsPointingInIcon className="size-4" />
                ) : (
                  <ArrowsPointingOutIcon className="size-4" />
                )}
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="p-1 text-text-muted hover:text-text-primary"
              >
                <XMarkIcon className="size-4" />
              </button>
            )}
          </div>
        </div>

        {/* Empty content */}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            <p className="text-text-muted text-sm">暂无内容</p>
            <p className="text-text-tertiary text-xs mt-1">
              让 AI 生成代码或文档后会显示在这里
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'h-full flex flex-col border-l border-border overflow-hidden bg-surface',
        isFullscreen && 'fixed inset-0 z-50',
        className
      )}
    >
      {/* Compact header: tabs + actions */}
      <div className="flex items-center justify-between h-10 px-3 border-b border-border flex-shrink-0">
        {/* Tabs */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => setActiveTab('content')}
            className={classNames(
              'text-sm font-medium',
              activeTab === 'content'
                ? 'text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            )}
          >
            内容
          </button>
          <button
            onClick={() => setActiveTab('versions')}
            className={classNames(
              'text-sm font-medium flex items-center gap-1',
              activeTab === 'versions'
                ? 'text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            )}
          >
            版本
            {artifact && artifact.versions.length > 1 && (
              <span className="text-xs bg-muted px-1.5 py-0.5 rounded">
                {artifact.versions.length}
              </span>
            )}
          </button>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="p-1 text-text-muted hover:text-text-primary"
              title={isFullscreen ? '退出全屏' : '全屏'}
            >
              {isFullscreen ? (
                <ArrowsPointingInIcon className="size-4" />
              ) : (
                <ArrowsPointingOutIcon className="size-4" />
              )}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 text-text-muted hover:text-text-primary"
            >
              <XMarkIcon className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Action bar with version nav and copy/download - only for content tab */}
      {artifact && activeTab === 'content' && (
        <div className="flex items-center justify-end h-8 px-3 border-b border-border flex-shrink-0 bg-muted/30">
          {/* Version nav + actions */}
          <div className="flex items-center gap-1">
            {artifact.versions.length > 1 ? (
              <>
                <button
                  onClick={() => handleVersionNav('prev')}
                  disabled={artifact.version <= 1}
                  className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-40"
                  title="上一版本"
                >
                  <ChevronLeftIcon className="size-3.5" />
                </button>
                <span className="text-xs text-text-muted">
                  v{artifact.version}/{artifact.versions.length}
                </span>
                <button
                  onClick={() => handleVersionNav('next')}
                  disabled={artifact.version >= artifact.versions.length}
                  className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-40"
                  title="下一版本"
                >
                  <ChevronRightIcon className="size-3.5" />
                </button>
                <div className="w-px h-3 bg-border mx-1" />
              </>
            ) : (
              <>
                <span className="text-xs text-text-muted mr-1">v1</span>
                <div className="w-px h-3 bg-border mx-1" />
              </>
            )}
            <button
              onClick={handleCopy}
              className="p-1 text-text-muted hover:text-text-primary"
              title={copied ? '已复制' : '复制'}
            >
              {copied ? (
                <CheckIcon className="size-3.5 text-green-600" />
              ) : (
                <ClipboardDocumentIcon className="size-3.5" />
              )}
            </button>
            <button
              onClick={handleDownload}
              className="p-1 text-text-muted hover:text-text-primary"
              title="下载"
            >
              <ArrowDownTrayIcon className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main content area - full height */}
      <div className="flex-1 overflow-auto min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-full gap-2">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
            <span className="text-sm text-text-muted">加载中...</span>
          </div>
        ) : activeTab === 'content' ? (
          <div className="p-3 h-full">
            {artifact?.artifact_type === 'code' ? (
              <pre className="text-sm font-mono bg-muted/30 p-3 rounded h-full overflow-auto">
                <code className="text-text-primary whitespace-pre-wrap break-words">
                  {artifact.content}
                </code>
              </pre>
            ) : (
              <div className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed h-full overflow-auto">
                {artifact?.content}
              </div>
            )}
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {artifact?.versions && artifact.versions.length > 0 ? (
              [...artifact.versions].reverse().map((v) => (
                <button
                  key={v.version}
                  onClick={() => {
                    onVersionRevert?.(v.version)
                    setActiveTab('content')
                  }}
                  className={classNames(
                    'w-full text-left rounded border border-border bg-surface p-3 hover:bg-muted/50 transition-colors',
                    v.version === artifact.version ? 'ring-2 ring-primary' : ''
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ClockIcon className="size-4 text-text-muted" />
                      <span className="text-sm font-medium text-text-primary">
                        版本 {v.version}
                      </span>
                      {v.version === artifact.version && (
                        <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                          当前
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-text-muted">
                      {new Date(v.created_at).toLocaleString()}
                    </span>
                  </div>
                </button>
              ))
            ) : (
              <div className="text-center py-8">
                <p className="text-text-muted text-sm">暂无版本历史</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
