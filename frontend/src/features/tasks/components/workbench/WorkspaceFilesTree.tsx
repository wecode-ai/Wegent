// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { taskApis, WorkspaceFile, WorkspaceFilesResponse } from '@/apis/tasks'
import { getFileIcon, formatFileSize } from '@/apis/attachments'

interface WorkspaceFilesTreeProps {
  taskId: number
}

// File tree node component
function FileTreeNode({
  file,
  depth = 0,
  defaultExpanded = false,
}: {
  file: WorkspaceFile
  depth?: number
  defaultExpanded?: boolean
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  const isDirectory = file.type === 'directory'
  const hasChildren = isDirectory && file.children && file.children.length > 0

  // Get file extension for icon
  const getExtension = (filename: string): string => {
    const lastDot = filename.lastIndexOf('.')
    return lastDot >= 0 ? filename.substring(lastDot) : ''
  }

  return (
    <div>
      <div
        className={`flex items-center py-1.5 px-2 hover:bg-muted/50 rounded-md cursor-pointer transition-colors ${
          depth > 0 ? 'ml-4' : ''
        }`}
        onClick={() => isDirectory && setIsExpanded(!isExpanded)}
      >
        {/* Expand/collapse icon for directories */}
        <div className="w-4 h-4 mr-1 flex-shrink-0">
          {isDirectory && hasChildren && (
            <ChevronRightIcon
              className={`w-4 h-4 text-text-muted transition-transform ${
                isExpanded ? 'rotate-90' : ''
              }`}
            />
          )}
        </div>

        {/* File/folder icon */}
        <span className="mr-2 flex-shrink-0">
          {isDirectory ? (
            isExpanded ? (
              <FolderOpenIcon className="w-4 h-4 text-primary" />
            ) : (
              <FolderIcon className="w-4 h-4 text-primary" />
            )
          ) : (
            <span className="text-sm">{getFileIcon(getExtension(file.name))}</span>
          )}
        </span>

        {/* File name */}
        <span className="text-sm text-text-primary truncate flex-1">{file.name}</span>

        {/* File size for files */}
        {!isDirectory && file.size !== undefined && (
          <span className="text-xs text-text-muted ml-2 flex-shrink-0">
            {formatFileSize(file.size)}
          </span>
        )}
      </div>

      {/* Children */}
      {isDirectory && isExpanded && file.children && (
        <div>
          {file.children.map((child, index) => (
            <FileTreeNode
              key={`${child.path}-${index}`}
              file={child}
              depth={depth + 1}
              defaultExpanded={false}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function WorkspaceFilesTree({ taskId }: WorkspaceFilesTreeProps) {
  const { t } = useTranslation('tasks')
  const [filesData, setFilesData] = useState<WorkspaceFilesResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)

  // Load workspace files
  const loadFiles = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await taskApis.getWorkspaceFiles(taskId)
      setFilesData(response)

      if (response.error) {
        setError(response.error)
      }
    } catch (err) {
      setError('connection_error')
      console.error('Failed to load workspace files:', err)
    } finally {
      setIsLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // Handle download
  const handleDownload = async () => {
    setIsDownloading(true)
    try {
      const blob = await taskApis.downloadWorkspaceZip(taskId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `task_${taskId}_files.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to download workspace files:', err)
      // Show error but don't block UI
    } finally {
      setIsDownloading(false)
    }
  }

  // Get error message based on error code
  const getErrorMessage = (errorCode: string): string => {
    const errorMessages: Record<string, string> = {
      container_not_found: t('workbench.workspace_files.container_not_found'),
      container_stopped: t('workbench.workspace_files.container_stopped'),
      timeout: t('workbench.workspace_files.timeout'),
      connection_error: t('workbench.workspace_files.connection_error'),
      list_files_failed: t('workbench.workspace_files.list_files_failed'),
    }
    return errorMessages[errorCode] || t('workbench.workspace_files.unknown_error')
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent"></div>
        <span className="ml-3 text-sm text-text-muted">
          {t('workbench.workspace_files.loading')}
        </span>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-6">
        <div className="flex flex-col items-center text-center">
          <ExclamationTriangleIcon className="w-10 h-10 text-amber-600 dark:text-amber-400 mb-3" />
          <h4 className="text-base font-medium text-amber-800 dark:text-amber-200">
            {getErrorMessage(error)}
          </h4>
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300 max-w-md">
            {error === 'container_stopped' || error === 'container_not_found'
              ? t('workbench.workspace_files.container_stopped_hint')
              : t('workbench.workspace_files.error_hint')}
          </p>
          <button
            onClick={loadFiles}
            className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors"
          >
            <ArrowPathIcon className="w-4 h-4 mr-2" />
            {t('workbench.retry')}
          </button>
        </div>
      </div>
    )
  }

  // Empty state
  if (!filesData || filesData.files.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center">
        <FolderIcon className="w-12 h-12 text-text-muted mx-auto mb-3" />
        <p className="text-text-muted">{t('workbench.workspace_files.no_files')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header with download button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-text-primary">
            {t('workbench.workspace_files.title')}
          </h3>
          <span className="text-xs text-text-muted">
            ({filesData.total_count} {t('workbench.workspace_files.files_count')})
          </span>
          {filesData.truncated && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              ({t('workbench.workspace_files.truncated')})
            </span>
          )}
        </div>

        <button
          onClick={handleDownload}
          disabled={isDownloading}
          className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-text-primary bg-surface border border-border rounded-md hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isDownloading ? (
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent mr-2" />
          ) : (
            <ArrowDownTrayIcon className="w-4 h-4 mr-2" />
          )}
          {t('workbench.workspace_files.download_all')}
        </button>
      </div>

      {/* File tree */}
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div className="max-h-96 overflow-y-auto p-2">
          {filesData.files.map((file, index) => (
            <FileTreeNode
              key={`${file.path}-${index}`}
              file={file}
              depth={0}
              defaultExpanded={true} // Expand first level by default
            />
          ))}
        </div>
      </div>
    </div>
  )
}
