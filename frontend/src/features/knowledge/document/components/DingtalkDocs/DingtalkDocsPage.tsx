// SPDX-FileCopyrightText: 2025 ZINFOID_00AQ, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingtalkDocsPage - Main page component for DingTalk document browsing.
 *
 * Layout: header with sync button + tabs for "My Documents" and "Knowledge Base".
 */

'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FolderOpen, BookOpen, ExternalLink } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDateTime } from '@/utils/dateTime'
import { dingtalkDocApi } from '@/apis/dingtalk-doc'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { DingtalkDocTreeView } from './DingtalkDocTreeView'
import { DingtalkNotConfigured } from './dingtalk-not-configured'
import type { DingtalkDocNode, DingtalkSyncStatus } from '@/types/dingtalk-doc'

interface DingtalkDocsPageProps {
  /** Whether DingTalk Docs MCP is configured for the user */
  isConfigured: boolean
  /** Whether DingTalk Workspace MCP is configured for the user */
  isWorkspaceConfigured?: boolean
  /** Callback when sync completes (to refresh sidebar count) */
  onSyncComplete?: () => void
}

export function DingtalkDocsPage({
  isConfigured,
  isWorkspaceConfigured = false,
  onSyncComplete,
}: DingtalkDocsPageProps) {
  const { t } = useTranslation('knowledge')
  const [activeTab, setActiveTab] = useState<'my-docs' | 'workspace'>('my-docs')

  // My Docs state
  const [docTree, setDocTree] = useState<DingtalkDocNode[]>([])
  const [docTotalCount, setDocTotalCount] = useState(0)
  const [docSyncStatus, setDocSyncStatus] = useState<DingtalkSyncStatus | null>(null)
  const [isLoadingDocs, setIsLoadingDocs] = useState(false)
  const [isSyncingDocs, setIsSyncingDocs] = useState(false)

  // Workspace state
  const [workspaceTree, setWorkspaceTree] = useState<DingtalkDocNode[]>([])
  const [workspaceTotalCount, setWorkspaceTotalCount] = useState(0)
  const [workspaceSyncStatus, setWorkspaceSyncStatus] = useState<DingtalkSyncStatus | null>(null)
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(false)
  const [isSyncingWorkspace, setIsSyncingWorkspace] = useState(false)

  // Load docs sync status on mount
  useEffect(() => {
    dingtalkDocApi.getSyncStatus().then(setDocSyncStatus).catch(() => {})
  }, [])

  // Load workspace sync status on mount
  useEffect(() => {
    if (isWorkspaceConfigured) {
      dingtalkDocApi.getWorkspaceSyncStatus().then(setWorkspaceSyncStatus).catch(() => {})
    }
  }, [isWorkspaceConfigured])

  // Load docs when status shows synced content
  useEffect(() => {
    if (docSyncStatus && docSyncStatus.total_nodes > 0) {
      loadDocs()
    }
  }, [docSyncStatus?.total_nodes]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load workspace when status shows synced content
  useEffect(() => {
    if (workspaceSyncStatus && workspaceSyncStatus.total_nodes > 0) {
      loadWorkspace()
    }
  }, [workspaceSyncStatus?.total_nodes]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadDocs = useCallback(async () => {
    setIsLoadingDocs(true)
    try {
      const response = await dingtalkDocApi.getDocs()
      setDocTree(response.nodes)
      setDocTotalCount(response.total_count)
    } catch (error) {
      console.error('Failed to load DingTalk docs:', error)
    } finally {
      setIsLoadingDocs(false)
    }
  }, [])

  const loadWorkspace = useCallback(async () => {
    setIsLoadingWorkspace(true)
    try {
      const response = await dingtalkDocApi.getWorkspaceNodes()
      setWorkspaceTree(response.nodes)
      setWorkspaceTotalCount(response.total_count)
    } catch (error) {
      console.error('Failed to load DingTalk workspace:', error)
    } finally {
      setIsLoadingWorkspace(false)
    }
  }, [])

  const handleSyncDocs = useCallback(async () => {
    setIsSyncingDocs(true)
    try {
      await dingtalkDocApi.syncDocs()
      const [docsResponse, status] = await Promise.all([
        dingtalkDocApi.getDocs(),
        dingtalkDocApi.getSyncStatus(),
      ])
      setDocTree(docsResponse.nodes)
      setDocTotalCount(docsResponse.total_count)
      setDocSyncStatus(status)
      onSyncComplete?.()
    } catch (error) {
      console.error('Failed to sync DingTalk docs:', error)
    } finally {
      setIsSyncingDocs(false)
    }
  }, [onSyncComplete])

  const handleSyncWorkspace = useCallback(async () => {
    setIsSyncingWorkspace(true)
    try {
      await dingtalkDocApi.syncWorkspaceNodes()
      const [wsResponse, status] = await Promise.all([
        dingtalkDocApi.getWorkspaceNodes(),
        dingtalkDocApi.getWorkspaceSyncStatus(),
      ])
      setWorkspaceTree(wsResponse.nodes)
      setWorkspaceTotalCount(wsResponse.total_count)
      setWorkspaceSyncStatus(status)
      onSyncComplete?.()
    } catch (error) {
      console.error('Failed to sync DingTalk workspace:', error)
    } finally {
      setIsSyncingWorkspace(false)
    }
  }, [onSyncComplete])

  const isSyncing = activeTab === 'my-docs' ? isSyncingDocs : isSyncingWorkspace
  const handleSync = activeTab === 'my-docs' ? handleSyncDocs : handleSyncWorkspace
  const activeSyncStatus = activeTab === 'my-docs' ? docSyncStatus : workspaceSyncStatus

  if (!isConfigured && !isWorkspaceConfigured) {
    return <DingtalkNotConfigured />
  }

  return (
    <div className="flex flex-col h-full" data-testid="dingtalk-docs-page">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <FolderOpen className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold text-text-primary">
            {t('document.sidebar.dingtalk', '钉钉文档')}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {activeSyncStatus?.last_synced_at && (
            <span className="text-xs text-text-muted">
              {t('document.dingtalk.lastSynced', '上次同步')}:{' '}
              {formatDateTime(new Date(activeSyncStatus.last_synced_at).getTime())}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={
              isSyncing ||
              (activeTab === 'my-docs' ? !isConfigured : !isWorkspaceConfigured)
            }
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

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'my-docs' | 'workspace')}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList className="mx-6 mt-3 self-start rounded-md">
          <TabsTrigger value="my-docs" data-testid="dingtalk-tab-my-docs">
            <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
            {t('document.dingtalk.myDocs', '我的文档')}
            {docTotalCount > 0 && (
              <span className="ml-1.5 text-xs text-text-muted">({docTotalCount})</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="workspace" data-testid="dingtalk-tab-workspace">
            <BookOpen className="w-3.5 h-3.5 mr-1.5" />
            {t('document.dingtalk.workspace', '知识库')}
            {workspaceTotalCount > 0 && (
              <span className="ml-1.5 text-xs text-text-muted">({workspaceTotalCount})</span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* My Docs tab */}
        <TabsContent value="my-docs" className="flex-1 flex flex-col min-h-0 mt-3">
          {!isConfigured ? (
            <DingtalkNotConfigured />
          ) : isLoadingDocs ? (
            <div className="flex-1 flex items-center justify-center">
              <Spinner size="lg" />
            </div>
          ) : docTotalCount === 0 ? (
            <DingtalkEmptyState
              onSync={handleSyncDocs}
              isSyncing={isSyncingDocs}
              hint={t('document.dingtalk.syncHint', '点击同步按钮从钉钉拉取文档列表')}
              t={t}
            />
          ) : (
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              <DingtalkDocTreeView nodes={docTree} />
            </div>
          )}
        </TabsContent>

        {/* Workspace tab */}
        <TabsContent value="workspace" className="flex-1 flex flex-col min-h-0 mt-3">
          {!isWorkspaceConfigured ? (
            <WorkspaceNotConfigured t={t} />
          ) : isLoadingWorkspace ? (
            <div className="flex-1 flex items-center justify-center">
              <Spinner size="lg" />
            </div>
          ) : workspaceTotalCount === 0 ? (
            <DingtalkEmptyState
              onSync={handleSyncWorkspace}
              isSyncing={isSyncingWorkspace}
              hint={t('document.dingtalk.workspaceSyncHint', '点击同步按钮从钉钉拉取知识库')}
              t={t}
            />
          ) : (
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              <DingtalkDocTreeView nodes={workspaceTree} />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** Shared empty state component used by both tabs. */
function DingtalkEmptyState({
  onSync,
  isSyncing,
  hint,
  t,
}: {
  onSync: () => void
  isSyncing: boolean
  hint: string
  t: (key: string, fallback?: string) => string
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
      <FolderOpen className="w-16 h-16 text-text-muted mb-4" />
      <h3 className="text-lg font-medium text-text-primary mb-2">
        {t('document.dingtalk.emptyState', '暂无文档')}
      </h3>
      <p className="text-sm text-text-muted mb-4">{hint}</p>
      <Button
        variant="primary"
        onClick={onSync}
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
  )
}

/** Shown in workspace tab when workspace MCP is not configured. */
function WorkspaceNotConfigured({ t }: { t: (key: string, fallback?: string) => string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
      <BookOpen className="w-16 h-16 text-text-muted mb-4" />
      <h3 className="text-lg font-medium text-text-primary mb-2">
        {t('document.dingtalk.workspaceNotConfigured', '钉钉知识库 MCP 未配置')}
      </h3>
      <p className="text-sm text-text-muted mb-4">
        {t('document.dingtalk.workspaceConfigureHint', '请前往设置配置钉钉知识库 MCP')}
      </p>
      <a
        href="/settings?section=integrations&tab=integrations"
        className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium transition-colors"
      >
        {t('document.dingtalk.goToSettings', '前往设置')}
        <ExternalLink className="w-3.5 h-3.5" />
      </a>
    </div>
  )
}
