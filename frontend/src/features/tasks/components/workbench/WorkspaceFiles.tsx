// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  ChevronRightIcon,
  DocumentIcon,
  FolderIcon,
  FolderOpenIcon,
  ArrowDownTrayIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { taskApis, WorkspaceFile, WorkspaceFilesResponse } from '@/apis/tasks'
import { Button } from '@/components/ui/button'

interface WorkspaceFilesProps {
  taskId: number
}

// File icon mapping by extension
const FILE_ICONS: Record<string, string> = {
  // Programming
  ts: '📄',
  tsx: '⚛️',
  js: '📜',
  jsx: '⚛️',
  py: '🐍',
  rb: '💎',
  go: '🔷',
  rs: '🦀',
  java: '☕',
  kt: '🟣',
  swift: '🍎',
  c: '🔧',
  cpp: '🔧',
  h: '📋',
  cs: '🟢',
  php: '🐘',

  // Web
  html: '🌐',
  htm: '🌐',
  css: '🎨',
  scss: '🎨',
  less: '🎨',
  svg: '🖼️',

  // Data
  json: '📋',
  yaml: '📋',
  yml: '📋',
  xml: '📋',
  toml: '📋',
  ini: '⚙️',
  env: '🔐',

  // Documentation
  md: '📝',
  mdx: '📝',
  txt: '📄',
  rst: '📝',

  // Config
  lock: '🔒',
  config: '⚙️',
  gitignore: '🙈',
  dockerfile: '🐳',
  dockerignore: '🐳',

  // Images
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  webp: '🖼️',
  ico: '🖼️',

  // Archive
  zip: '📦',
  tar: '📦',
  gz: '📦',
  rar: '📦',

  // Default
  default: '📄',
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return FILE_ICONS[ext] || FILE_ICONS.default
}

function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) return ''
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

interface FileTreeNodeProps {
  file: WorkspaceFile
  level: number
  defaultExpanded?: boolean
}

function FileTreeNode({ file, level, defaultExpanded = false }: FileTreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded && level < 2)
  const isDirectory = file.type === 'directory'

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 px-2 rounded-md hover:bg-muted transition-colors cursor-pointer text-sm ${
          level === 0 ? '' : 'ml-4'
        }`}
        onClick={() => isDirectory && setIsExpanded(!isExpanded)}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        {isDirectory ? (
          <>
            <ChevronRightIcon
              className={`h-4 w-4 text-text-muted transition-transform ${
                isExpanded ? 'rotate-90' : ''
              }`}
            />
            {isExpanded ? (
              <FolderOpenIcon className="h-4 w-4 text-primary" />
            ) : (
              <FolderIcon className="h-4 w-4 text-primary" />
            )}
          </>
        ) : (
          <>
            <span className="w-4" />
            <span className="text-sm">{getFileIcon(file.name)}</span>
          </>
        )}
        <span className="flex-1 truncate text-text-primary">{file.name}</span>
        {!isDirectory && file.size !== undefined && (
          <span className="text-xs text-text-muted">{formatFileSize(file.size)}</span>
        )}
      </div>

      {isDirectory && isExpanded && file.children && (
        <div>
          {file.children.map((child, index) => (
            <FileTreeNode key={`${child.path}-${index}`} file={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function WorkspaceFiles({ taskId }: WorkspaceFilesProps) {
  const { t } = useTranslation('tasks')
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [totalFiles, setTotalFiles] = useState(0)
  const [totalSize, setTotalSize] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isDownloading, setIsDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorType, setErrorType] = useState<'container_stopped' | 'network' | 'unknown'>('unknown')

  const loadFiles = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await taskApis.getWorkspaceFiles(taskId)
      setFiles(response.files)
      setTotalFiles(response.total_files)
      setTotalSize(response.total_size)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(errorMessage)

      // Determine error type
      if (
        errorMessage.includes('503') ||
        errorMessage.toLowerCase().includes('container') ||
        errorMessage.toLowerCase().includes('not running') ||
        errorMessage.toLowerCase().includes('stopped')
      ) {
        setErrorType('container_stopped')
      } else if (
        errorMessage.toLowerCase().includes('network') ||
        errorMessage.toLowerCase().includes('timeout') ||
        errorMessage.includes('504')
      ) {
        setErrorType('network')
      } else {
        setErrorType('unknown')
      }
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        <span className="ml-3 text-text-muted">{t('workbench.workspace_files.loading')}</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-6">
        <div className="flex flex-col items-center text-center">
          <ExclamationTriangleIcon className="w-10 h-10 text-amber-600 dark:text-amber-400 mb-3" />
          <h4 className="text-base font-medium text-amber-800 dark:text-amber-200">
            {errorType === 'container_stopped'
              ? t('workbench.workspace_files.container_stopped_title')
              : t('workbench.workspace_files.error_title')}
          </h4>
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300 max-w-md">
            {errorType === 'container_stopped'
              ? t('workbench.workspace_files.container_stopped')
              : errorType === 'network'
                ? t('workbench.workspace_files.network_error')
                : error}
          </p>
          <button
            onClick={loadFiles}
            className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium text-amber-800 dark:text-amber-200 bg-amber-100 dark:bg-amber-800/30 hover:bg-amber-200 dark:hover:bg-amber-800/50 rounded-md transition-colors"
          >
            <ArrowPathIcon className="w-4 h-4 mr-2" />
            {t('workbench.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center">
        <DocumentIcon className="w-12 h-12 text-text-muted mx-auto mb-3" />
        <p className="text-text-muted">{t('workbench.workspace_files.no_files')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header with download button */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-text-muted">
          {t('workbench.workspace_files.file_count', { count: totalFiles })}
          {totalSize > 0 && ` (${formatFileSize(totalSize)})`}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={isDownloading}
          className="h-8"
        >
          {isDownloading ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2"></div>
              {t('workbench.workspace_files.downloading')}
            </>
          ) : (
            <>
              <ArrowDownTrayIcon className="w-4 h-4 mr-2" />
              {t('workbench.workspace_files.download_all')}
            </>
          )}
        </Button>
      </div>

      {/* File tree */}
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="max-h-[500px] overflow-y-auto p-2">
          {files.map((file, index) => (
            <FileTreeNode key={`${file.path}-${index}`} file={file} level={0} defaultExpanded />
          ))}
        </div>
      </div>

      {/* Warning if too many files */}
      {totalFiles >= 1000 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 text-center">
          {t('workbench.workspace_files.too_many_files')}
        </div>
      )}
    </div>
  )
}
