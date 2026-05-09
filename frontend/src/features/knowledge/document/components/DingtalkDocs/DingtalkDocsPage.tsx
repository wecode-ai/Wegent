// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingtalkDocsPage - Main page component for DingTalk document browsing.
 *
 * Layout: header with sync button + full-width document tree view.
 */

'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FolderOpen } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDateTime } from '@/utils/dateTime'
import { dingtalkDocApi } from '@/apis/dingtalk-doc'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { DingtalkDocTreeView } from './DingtalkDocTreeView'
import { DingtalkNotConfigured } from './dingtalk-not-configured'
import type { DingtalkDocNode, DingtalkSyncStatus } from '@/types/dingtalk-doc'

interface DingtalkDocsPageProps {
  /** Whether DingTalk MCP is configured for the user */
  isConfigured: boolean
  /** Callback when sync completes (to refresh sidebar count) */
  onSyncComplete?: () => void
}

export function DingtalkDocsPage({ isConfigured, onSyncComplete }: DingtalkDocsPageProps) {
  const { t } = useTranslation('knowledge')

  // Data state
  const [docTree, setDocTree] = useState<DingtalkDocNode[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [syncStatus, setSyncStatus] = useState<DingtalkSyncStatus | null>(null)

  // Loading states
  const [isLoadingDocs, setIsLoadingDocs] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)

  // Load sync status on mount
  useEffect(() => {
    const loadStatus = async () => {
      try {
        const status = await dingtalkDocApi.getSyncStatus()
        setSyncStatus(status)
      } catch {
        // Ignore - may not be configured
      }
    }
    loadStatus()
  }, [])

  // Load docs if there are synced nodes
  useEffect(() => {
    if (syncStatus && syncStatus.total_nodes > 0) {
      loadDocs()
    }
  }, [syncStatus?.total_nodes]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadDocs = useCallback(async () => {
    setIsLoadingDocs(true)
    try {
      const response = await dingtalkDocApi.getDocs()
      setDocTree(response.nodes)
      setTotalCount(response.total_count)
    } catch (error) {
      console.error('Failed to load DingTalk docs:', error)
    } finally {
      setIsLoadingDocs(false)
    }
  }, [])

  const handleSync = useCallback(async () => {
    setIsSyncing(true)
    try {
      await dingtalkDocApi.syncDocs()
      // Reload docs and status after sync
      const [docsResponse, status] = await Promise.all([
        dingtalkDocApi.getDocs(),
        dingtalkDocApi.getSyncStatus(),
      ])
      setDocTree(docsResponse.nodes)
      setTotalCount(docsResponse.total_count)
      setSyncStatus(status)
      onSyncComplete?.()
    } catch (error) {
      console.error('Failed to sync DingTalk docs:', error)
    } finally {
      setIsSyncing(false)
    }
  }, [onSyncComplete])

  // Not configured state
  if (!isConfigured) {
    return <DingtalkNotConfigured />
  }

  return (
    <div className="flex flex-col h-full" data-testid="dingtalk-docs-page">
      {/* Header with title and sync button */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <FolderOpen className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold text-text-primary">
            {t('document.sidebar.dingtalk', '钉钉文档')}
          </h2>
          <span className="text-sm text-text-muted">
            {t('document.dingtalk.docCount', '{{count}} 个文档', { count: totalCount })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {syncStatus?.last_synced_at && (
            <span className="text-xs text-text-muted">
              {t('document.dingtalk.lastSynced', '上次同步')}:{' '}
              {formatDateTime(new Date(syncStatus.last_synced_at).getTime())}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={isSyncing}
            className="h-11 min-w-[44px]"
            data-testid="dingtalk-sync-button"
          >
            {isSyncing ? (
              <>
                <Spinner size="sm" className="mr-1" />
                {t('document.dingtalk.syncing', '同步中...')}
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                {t('document.dingtalk.sync', '同步')}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Content area */}
      {isLoadingDocs ? (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      ) : totalCount === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
          <FolderOpen className="w-16 h-16 text-text-muted mb-4" />
          <h3 className="text-lg font-medium text-text-primary mb-2">
            {t('document.dingtalk.emptyState', '暂无文档')}
          </h3>
          <p className="text-sm text-text-muted mb-4">
            {t('document.dingtalk.syncHint', '点击同步按钮从钉钉拉取文档列表')}
          </p>
          <Button
            variant="primary"
            onClick={handleSync}
            disabled={isSyncing}
            className="h-11 min-w-[44px]"
          >
            {isSyncing ? (
              <>
                <Spinner size="sm" className="mr-1" />
                {t('document.dingtalk.syncing', '同步中...')}
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                {t('document.dingtalk.sync', '同步')}
              </>
            )}
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <DingtalkDocTreeView nodes={docTree} />
        </div>
      )}
    </div>
  )
}
