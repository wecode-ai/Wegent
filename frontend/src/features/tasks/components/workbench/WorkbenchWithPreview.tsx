// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Workbench Container with Preview Panel
 *
 * This component combines the Workbench and PreviewPanel into a unified layout.
 * The preview panel appears on the right side of the workbench when enabled.
 */

import { useState, useCallback, useEffect } from 'react'
import Workbench from './Workbench'
import PreviewPanel from './PreviewPanel'
import { previewApis } from '@/apis/preview'
import type { PreviewStatus, ViewportSize, PreviewConfigResponse } from '@/types/preview'
import { EyeIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'

interface WorkbenchData {
  taskTitle: string
  taskNumber: string
  status: 'running' | 'completed' | 'failed'
  completedTime: string
  repository: string
  branch: string
  sessions: number
  premiumRequests: number
  lastUpdated: string
  summary: string
  changes: string[]
  originalPrompt: string
  file_changes: Array<{
    old_path: string
    new_path: string
    new_file: boolean
    renamed_file: boolean
    deleted_file: boolean
    added_lines: number
    removed_lines: number
    diff_title: string
  }>
  git_info: {
    initial_commit_id: string
    initial_commit_message: string
    task_commits: Array<{
      commit_id: string
      short_id: string
      message: string
      author: string
      author_email: string
      committed_date: string
      stats: {
        files_changed: number
        insertions: number
        deletions: number
      }
    }>
    source_branch: string
    target_branch: string
  }
  git_type?: 'github' | 'gitlab'
  git_domain?: string
}

interface WorkbenchWithPreviewProps {
  isOpen: boolean
  onClose: () => void
  onOpen: () => void
  workbenchData?: WorkbenchData | null
  isLoading?: boolean
  taskTitle?: string
  taskNumber?: string
  taskId?: number
  thinking?: Array<{
    title: string
    next_action: string
    details?: Record<string, unknown>
  }> | null
}

export default function WorkbenchWithPreview({
  isOpen,
  onClose,
  onOpen,
  workbenchData,
  isLoading = false,
  taskTitle,
  taskNumber,
  taskId,
  thinking,
}: WorkbenchWithPreviewProps) {
  const { t } = useTranslation('tasks')

  // Preview state
  const [previewEnabled, setPreviewEnabled] = useState(false)
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('disabled')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [viewportSize, setViewportSize] = useState<ViewportSize>('desktop')
  const [currentPath, setCurrentPath] = useState('/')

  // Load preview config when task changes
  useEffect(() => {
    if (!taskId) {
      setPreviewEnabled(false)
      setPreviewStatus('disabled')
      setPreviewUrl(null)
      setIsPanelOpen(false)
      return
    }

    const loadConfig = async () => {
      try {
        const config: PreviewConfigResponse = await previewApis.getConfig(taskId)
        setPreviewEnabled(config.enabled)
        setPreviewStatus(config.status)
        setPreviewUrl(config.url || null)
        setPreviewError(config.error || null)

        // Auto-open panel if preview is ready
        if (config.enabled && config.status === 'ready') {
          setIsPanelOpen(true)
        }
      } catch (error) {
        console.error('[WorkbenchWithPreview] Error loading preview config:', error)
        setPreviewEnabled(false)
        setPreviewStatus('disabled')
      }
    }

    loadConfig()
  }, [taskId])

  // Start preview
  const handleStartPreview = useCallback(async () => {
    if (!taskId) return

    setPreviewLoading(true)
    setPreviewStatus('starting')
    setPreviewError(null)

    try {
      const response = await previewApis.start(taskId)
      setPreviewStatus(response.status)
      setPreviewUrl(response.url || null)

      if (!response.success) {
        setPreviewError(response.message)
      } else {
        setIsPanelOpen(true)
      }
    } catch (error) {
      console.error('[WorkbenchWithPreview] Error starting preview:', error)
      setPreviewStatus('error')
      setPreviewError(error instanceof Error ? error.message : 'Failed to start preview')
    } finally {
      setPreviewLoading(false)
    }
  }, [taskId])

  // Stop preview
  const handleStopPreview = useCallback(async () => {
    if (!taskId) return

    try {
      await previewApis.stop(taskId)
      setPreviewStatus('stopped')
      setPreviewUrl(null)
    } catch (error) {
      console.error('[WorkbenchWithPreview] Error stopping preview:', error)
    }
  }, [taskId])

  // Refresh preview
  const handleRefresh = useCallback(() => {
    // Refresh is handled by PreviewPanel internally via iframe key change
  }, [])

  // Navigate to path
  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(path.startsWith('/') ? path : `/${path}`)
  }, [])

  // Build full URL
  const fullPreviewUrl = previewUrl
    ? `${previewUrl}${currentPath === '/' ? '' : currentPath}`
    : null

  if (!isOpen) {
    return null
  }

  return (
    <div className="flex h-full">
      {/* Main Workbench */}
      <div
        className="flex-1 h-full transition-all duration-300"
        style={{
          width: isPanelOpen && previewEnabled ? '50%' : '100%',
        }}
      >
        <Workbench
          isOpen={true}
          onClose={onClose}
          onOpen={onOpen}
          workbenchData={workbenchData}
          isLoading={isLoading}
          taskTitle={taskTitle}
          taskNumber={taskNumber}
          thinking={thinking}
        />
      </div>

      {/* Preview Toggle Button - shown when workbench is open and preview is enabled but panel is closed */}
      {previewEnabled && !isPanelOpen && (
        <button
          onClick={() => setIsPanelOpen(true)}
          className="
            absolute right-4 top-20 z-10
            flex items-center gap-2 px-3 py-2
            bg-primary text-white rounded-md shadow-lg
            hover:bg-primary/90 transition-colors
          "
          title={t('preview.title')}
        >
          <EyeIcon className="w-4 h-4" />
          <span className="text-sm">{t('preview.title')}</span>
        </button>
      )}

      {/* Preview Panel */}
      {previewEnabled && (
        <PreviewPanel
          isOpen={isPanelOpen}
          url={fullPreviewUrl}
          status={previewStatus}
          enabled={previewEnabled}
          viewportSize={viewportSize}
          currentPath={currentPath}
          error={previewError}
          isLoading={previewLoading}
          taskId={taskId}
          onClose={() => setIsPanelOpen(false)}
          onStart={handleStartPreview}
          onStop={handleStopPreview}
          onRefresh={handleRefresh}
          onViewportChange={setViewportSize}
          onNavigate={handleNavigate}
        />
      )}
    </div>
  )
}
