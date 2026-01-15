// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useMemo } from 'react'
import {
  History,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
  Download,
  MoreHorizontal,
  X,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Artifact, ArtifactVersion } from '../types'
import { getQuickActions } from '../constants/quickActions'
import { QuickActionsBar } from './QuickActionsBar'

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
  onArtifactUpdate,
  onQuickAction,
  onVersionRevert,
  className,
  isFullscreen = false,
  onToggleFullscreen,
}: CanvasPanelProps) {
  const [copied, setCopied] = useState(false)
  const [showVersionHistory, setShowVersionHistory] = useState(false)

  // Get quick actions for artifact type
  const quickActions = useMemo(() => {
    if (!artifact) return []
    return getQuickActions(artifact.artifact_type)
  }, [artifact?.artifact_type])

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
          'flex flex-col h-full bg-background border-l',
          className
        )}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-sm font-medium text-muted-foreground">Canvas</h3>
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center text-muted-foreground">
            <p className="text-sm">暂无内容</p>
            <p className="text-xs mt-1">
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
        'flex flex-col h-full bg-background border-l',
        isFullscreen && 'fixed inset-0 z-50 border-l-0',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-medium truncate">
            {artifact?.title || 'Untitled'}
          </h3>
          {artifact?.language && (
            <span className="text-xs px-1.5 py-0.5 bg-muted rounded text-muted-foreground">
              {artifact.language}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Version navigation */}
          {artifact && artifact.versions.length > 1 && (
            <TooltipProvider>
              <div className="flex items-center gap-1 mr-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={artifact.version <= 1}
                      onClick={() => handleVersionNav('prev')}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>上一版本</TooltipContent>
                </Tooltip>

                <span className="text-xs text-muted-foreground px-1">
                  v{artifact.version}/{artifact.versions.length}
                </span>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={artifact.version >= artifact.versions.length}
                      onClick={() => handleVersionNav('next')}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>下一版本</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
          )}

          {/* Actions menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleCopy}>
                {copied ? (
                  <Check className="mr-2 h-4 w-4" />
                ) : (
                  <Copy className="mr-2 h-4 w-4" />
                )}
                {copied ? '已复制!' : '复制'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDownload}>
                <Download className="mr-2 h-4 w-4" />
                下载
              </DropdownMenuItem>
              {artifact && artifact.versions.length > 1 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setShowVersionHistory(!showVersionHistory)}>
                    <History className="mr-2 h-4 w-4" />
                    版本历史
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Fullscreen toggle */}
          {onToggleFullscreen && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={onToggleFullscreen}
                  >
                    {isFullscreen ? (
                      <Minimize2 className="h-4 w-4" />
                    ) : (
                      <Maximize2 className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isFullscreen ? '退出全屏' : '全屏'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Close button */}
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : (
          <div className="h-full">
            {artifact?.artifact_type === 'code' ? (
              <pre className="text-sm font-mono bg-muted p-4 rounded-lg overflow-auto h-full">
                <code>{artifact.content}</code>
              </pre>
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
                {artifact?.content}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick actions bar */}
      {artifact && onQuickAction && (
        <QuickActionsBar
          artifactType={artifact.artifact_type}
          onAction={onQuickAction}
          disabled={isLoading}
        />
      )}

      {/* Version history sidebar */}
      {showVersionHistory && artifact && (
        <VersionHistorySidebar
          versions={artifact.versions}
          currentVersion={artifact.version}
          onSelect={(version) => {
            onVersionRevert?.(version)
            setShowVersionHistory(false)
          }}
          onClose={() => setShowVersionHistory(false)}
        />
      )}
    </div>
  )
}

// Version history sidebar component
interface VersionHistorySidebarProps {
  versions: ArtifactVersion[]
  currentVersion: number
  onSelect: (version: number) => void
  onClose: () => void
}

function VersionHistorySidebar({
  versions,
  currentVersion,
  onSelect,
  onClose,
}: VersionHistorySidebarProps) {
  return (
    <div className="absolute right-0 top-0 bottom-0 w-64 bg-background border-l shadow-lg z-10">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <h4 className="text-sm font-medium">版本历史</h4>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="overflow-auto max-h-[calc(100%-48px)]">
        {[...versions].reverse().map((v) => (
          <button
            key={v.version}
            onClick={() => onSelect(v.version)}
            className={cn(
              'w-full px-4 py-3 text-left hover:bg-muted transition-colors border-b',
              v.version === currentVersion && 'bg-primary/5'
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">版本 {v.version}</span>
              {v.version === currentVersion && (
                <span className="text-xs text-primary">当前</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {new Date(v.created_at).toLocaleString()}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}
