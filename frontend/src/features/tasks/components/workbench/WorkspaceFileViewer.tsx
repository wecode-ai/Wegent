// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  FolderIcon,
  FolderOpenIcon,
  DocumentIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { taskApis, WorkspaceFile } from '@/apis/tasks'

// File extension to icon mapping
const FILE_ICONS: Record<string, string> = {
  // Programming languages
  ts: '📘',
  tsx: '📘',
  js: '📒',
  jsx: '📒',
  py: '🐍',
  java: '☕',
  go: '🔵',
  rs: '🦀',
  rb: '💎',
  php: '🐘',
  c: '📄',
  cpp: '📄',
  h: '📄',
  cs: '📄',
  swift: '🍎',
  kt: '🟣',
  // Web
  html: '🌐',
  css: '🎨',
  scss: '🎨',
  less: '🎨',
  vue: '💚',
  svelte: '🧡',
  // Config
  json: '📋',
  yaml: '📋',
  yml: '📋',
  toml: '📋',
  xml: '📋',
  env: '🔒',
  // Documentation
  md: '📝',
  txt: '📄',
  rst: '📝',
  // Data
  sql: '🗄️',
  csv: '📊',
  // Shell
  sh: '⚙️',
  bash: '⚙️',
  zsh: '⚙️',
  // Other
  dockerfile: '🐳',
  makefile: '🔧',
  gitignore: '🚫',
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const lowerName = filename.toLowerCase()

  // Special filenames
  if (lowerName === 'dockerfile') return '🐳'
  if (lowerName === 'makefile') return '🔧'
  if (lowerName.startsWith('.gitignore')) return '🚫'
  if (lowerName.startsWith('.env')) return '🔒'

  return FILE_ICONS[ext] || '📄'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface FileTreeNodeProps {
  file: WorkspaceFile
  level: number
  defaultExpanded?: boolean
}

function FileTreeNode({ file, level, defaultExpanded = false }: FileTreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  const isDirectory = file.type === 'directory'
  const hasChildren = isDirectory && file.children && file.children.length > 0

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50 cursor-pointer transition-colors ${
          level > 0 ? 'ml-4' : ''
        }`}
        onClick={() => isDirectory && setIsExpanded(!isExpanded)}
      >
        {/* Expand/collapse chevron for directories */}
        {isDirectory ? (
          <ChevronRightIcon
            className={`w-4 h-4 text-text-muted transition-transform ${
              isExpanded ? 'rotate-90' : ''
            }`}
          />
        ) : (
          <span className="w-4" />
        )}

        {/* File/folder icon */}
        {isDirectory ? (
          isExpanded ? (
            <FolderOpenIcon className="w-5 h-5 text-amber-500" />
          ) : (
            <FolderIcon className="w-5 h-5 text-amber-500" />
          )
        ) : (
          <span className="text-sm">{getFileIcon(file.name)}</span>
        )}

        {/* File name */}
        <span className="flex-1 text-sm text-text-primary truncate">{file.name}</span>

        {/* File size for files */}
        {!isDirectory && file.size !== undefined && (
          <span className="text-xs text-text-muted">{formatFileSize(file.size)}</span>
        )}
      </div>

      {/* Children (for expanded directories) */}
      {isDirectory && isExpanded && hasChildren && (
        <div className="border-l border-border ml-4">
          {file.children!.map((child, index) => (
            <FileTreeNode
              key={`${child.path}-${index}`}
              file={child}
              level={level + 1}
              defaultExpanded={level < 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface WorkspaceFileViewerProps {
  taskId: number
}

export default function WorkspaceFileViewer({ taskId }: WorkspaceFileViewerProps) {
  const { t } = useTranslation('tasks')
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isDownloading, setIsDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalCount, setTotalCount] = useState(0)

  const loadFiles = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await taskApis.getWorkspaceFiles(taskId)
      setFiles(response.files)
      setTotalCount(response.total_count)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  const handleDownload = async () => {
    setIsDownloading(true)
    try {
      const blob = await taskApis.downloadWorkspaceZip(taskId)

      // Create download link
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `task_${taskId}_files.zip`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(errorMessage)
    } finally {
      setIsDownloading(false)
    }
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8">
        <div className="flex items-center justify-center gap-3">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
          <span className="text-sm text-text-muted">{t('workbench.workspace_files.loading')}</span>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    const isContainerStopped =
      error.includes('not running') ||
      error.includes('unreachable') ||
      error.includes('not available') ||
      error.includes('Container not found')

    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-6">
        <div className="flex flex-col items-center text-center">
          <ExclamationTriangleIcon className="w-10 h-10 text-amber-600 dark:text-amber-400 mb-3" />
          <h4 className="text-base font-medium text-amber-800 dark:text-amber-200">
            {isContainerStopped
              ? t('workbench.workspace_files.container_stopped')
              : t('workbench.workspace_files.error_title')}
          </h4>
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300 max-w-md">
            {isContainerStopped
              ? t('workbench.workspace_files.container_stopped_hint')
              : error}
          </p>
          {!isContainerStopped && (
            <button
              onClick={loadFiles}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors"
            >
              <ArrowPathIcon className="w-4 h-4" />
              {t('workbench.retry')}
            </button>
          )}
        </div>
      </div>
    )
  }

  // Empty state
  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center">
        <DocumentIcon className="w-12 h-12 text-text-muted mx-auto mb-3" />
        <p className="text-text-muted">{t('workbench.workspace_files.no_files')}</p>
      </div>
    )
  }

  // Files list
  return (
    <div className="space-y-4">
      {/* Header with download button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-text-primary">
            {t('workbench.workspace_files.title')}
          </h3>
          <span className="text-xs text-text-muted bg-muted px-2 py-0.5 rounded-full">
            {totalCount} {totalCount === 1 ? 'file' : 'files'}
          </span>
        </div>
        <button
          onClick={handleDownload}
          disabled={isDownloading}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-text-primary bg-surface border border-border hover:bg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isDownloading ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
              {t('workbench.workspace_files.downloading')}
            </>
          ) : (
            <>
              <ArrowDownTrayIcon className="w-4 h-4" />
              {t('workbench.workspace_files.download_all')}
            </>
          )}
        </button>
      </div>

      {/* File tree */}
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="p-2 max-h-[500px] overflow-y-auto">
          {files.map((file, index) => (
            <FileTreeNode
              key={`${file.path}-${index}`}
              file={file}
              level={0}
              defaultExpanded={true}
            />
          ))}
        </div>
      </div>

      {/* Refresh button */}
      <div className="flex justify-end">
        <button
          onClick={loadFiles}
          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
        >
          <ArrowPathIcon className="w-3.5 h-3.5" />
          {t('workbench.workspace_files.refresh')}
        </button>
      </div>
    </div>
  )
}
