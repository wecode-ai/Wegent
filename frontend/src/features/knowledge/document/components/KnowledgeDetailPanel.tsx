// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeDetailPanel renders the right-side detail area for the selected knowledge base.
 *
 * - When no KB is selected: shows empty state
 * - In Notebook view: shows chat interface with document panel
 * - In documents view: shows document list with management capabilities
 */

'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { Library, FileText, Shield } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { useTeamContext } from '@/contexts/TeamContext'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { ChatArea } from '@/features/tasks/components/chat'
import { DocumentList, type KbGroupInfo } from './DocumentList'
import { DocumentPanel } from './DocumentPanel'
import { KnowledgeBaseSummaryCard } from './KnowledgeBaseSummaryCard'
import { PermissionManagementTab } from '../../permission/components/PermissionManagementTab'
import { useKnowledgePermissions } from '../../permission/hooks/useKnowledgePermissions'
import { useNamespaceRoleMap } from '../hooks/useNamespaceRoleMap'
import {
  canManageKnowledgeBase,
  canManageKnowledgeBaseDocuments,
  canManageKnowledgeBasePermissions,
} from '@/utils/namespace-permissions'
import { getKnowledgeBase } from '@/apis/knowledge'
import type { KnowledgeBase, KnowledgeView } from '@/types/knowledge'
import type { Team } from '@/types/api'

interface KnowledgeDetailPanelProps {
  /** Currently selected knowledge base */
  selectedKb: KnowledgeBase | null
  /** Sync updated KB data back into sidebar state */
  onSyncKnowledgeBase?: (kb: KnowledgeBase) => void
  /** Whether the tree panel is collapsed */
  isTreeCollapsed?: boolean
  /** Callback to expand the tree panel */
  onExpandTree?: () => void
  /** Callback to edit the knowledge base */
  onEditKb?: (kb: KnowledgeBase) => void
  /** Group info for breadcrumb display */
  groupInfo?: KbGroupInfo
  /** Callback when group name is clicked */
  onGroupClick?: (groupId: string, groupType?: string) => void
  /** Initial document path to auto-open (from virtual URL path segments) */
  initialDocPath?: string
  /** Current view resolved from URL/default view */
  currentView: KnowledgeView
  /** Switches the current URL-scoped view */
  onViewChange: (view: KnowledgeView) => void
}

export function KnowledgeDetailPanel({
  selectedKb,
  onSyncKnowledgeBase,
  isTreeCollapsed: _isTreeCollapsed,
  onExpandTree: _onExpandTree,
  onEditKb: _onEditKb,
  groupInfo,
  onGroupClick,
  initialDocPath,
  currentView,
  onViewChange,
}: KnowledgeDetailPanelProps) {
  const { t } = useTranslation('knowledge')
  const { user } = useUser()

  // Task context - used to clear selected task when entering notebook mode
  const { selectTask } = useTaskSession()

  // Team context for ChatArea
  const { teams, isTeamsLoading, refreshTeams } = useTeamContext()

  // Tab state for documents/permissions (classic mode)
  const [activeTab, setActiveTab] = useState<'documents' | 'permissions'>('documents')

  // State for selected document IDs (for notebook mode context injection)
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<number[]>([])

  // Document panel collapsed state (for notebook mode)
  const [_isDocumentPanelCollapsed, setIsDocumentPanelCollapsed] = useState(false)

  const namespaceRoleMap = useNamespaceRoleMap()

  // Fetch user permission for this knowledge base
  const { myPermission, fetchMyPermission } = useKnowledgePermissions({
    kbId: selectedKb?.id || 0,
  })

  // Fetch my permission when knowledge base is loaded
  useEffect(() => {
    if (selectedKb) {
      fetchMyPermission()
    }
  }, [selectedKb, fetchMyPermission])

  // Filter teams for knowledge mode
  const filteredTeams = useMemo(() => {
    return teams.filter(team => {
      if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false
      if (!team.bind_mode) return true
      return team.bind_mode.includes('knowledge')
    })
  }, [teams])

  // Handle refresh teams
  const handleRefreshTeams = useCallback(async (): Promise<Team[]> => {
    return await refreshTeams()
  }, [refreshTeams])

  const handleRefreshKnowledgeBase = useCallback(async () => {
    if (!selectedKb || !onSyncKnowledgeBase) return
    const nextKb = await getKnowledgeBase(selectedKb.id)
    onSyncKnowledgeBase(nextKb)
  }, [selectedKb, onSyncKnowledgeBase])

  // Check if user can manage this knowledge base
  const canManageKb = useMemo(() => {
    if (!selectedKb || !user) return false
    return canManageKnowledgeBase({
      currentUserId: user.id,
      knowledgeBase: selectedKb,
      knowledgeRole: myPermission?.role,
      namespaceRole: namespaceRoleMap.get(selectedKb.namespace),
    })
  }, [selectedKb, user, myPermission?.role, namespaceRoleMap])

  const canUploadDocuments = useMemo(() => {
    if (!selectedKb || !user) return false
    return canManageKnowledgeBaseDocuments({
      currentUserId: user.id,
      knowledgeBase: selectedKb,
      knowledgeRole: myPermission?.role,
      namespaceRole: namespaceRoleMap.get(selectedKb.namespace),
    })
  }, [selectedKb, user, myPermission?.role, namespaceRoleMap])

  // Check if user can manage permissions (creator, namespace manager, or KB manager)
  const canManagePermissions = useMemo(() => {
    if (!selectedKb || !user) return false
    return canManageKnowledgeBasePermissions({
      currentUserId: user.id,
      knowledgeBase: selectedKb,
      knowledgeRole: myPermission?.role,
      namespaceRole: namespaceRoleMap.get(selectedKb.namespace),
    })
  }, [selectedKb, user, myPermission?.role, namespaceRoleMap])

  // Get search params to check for taskId in URL
  // Support multiple parameter formats for compatibility
  const searchParams = useSearchParams()
  const taskIdFromUrl = useMemo(() => {
    const fromSearchParams =
      searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid')
    if (fromSearchParams) return fromSearchParams
    // Fallback for replaceState scenarios where useSearchParams hasn't synced yet
    if (typeof window !== 'undefined') {
      const browserParams = new URLSearchParams(window.location.search)
      return (
        browserParams.get('taskId') || browserParams.get('task_id') || browserParams.get('taskid')
      )
    }
    return null
  }, [searchParams])

  // Use ref for taskIdFromUrl to avoid resetting panel state when taskId changes
  // (e.g., when replaceState adds ?taskId=... after sending a message)
  const taskIdFromUrlRef = useRef(taskIdFromUrl)
  taskIdFromUrlRef.current = taskIdFromUrl

  // Track previous KB id to distinguish initial mount from KB switch
  const prevKbIdRef = useRef<number | null>(null)

  // Reset state when KB changes
  // For Notebook view, clear the selected task unless taskId is the active source of truth.
  // - On initial mount: preserve task if taskId is in URL (user navigating from history)
  // - On KB switch: always clear task (the old taskId belongs to a different KB)
  useEffect(() => {
    setActiveTab('documents')
    setSelectedDocumentIds([])
    setIsDocumentPanelCollapsed(false)

    if (currentView === 'documents') {
      selectTask(null)
    }

    if (currentView === 'notebook') {
      const isKbSwitch = prevKbIdRef.current !== null && prevKbIdRef.current !== selectedKb?.id
      if (isKbSwitch || !taskIdFromUrlRef.current) {
        selectTask(null)
      }
    }

    if (selectedKb?.id != null) {
      prevKbIdRef.current = selectedKb.id
    }
  }, [selectedKb?.id, currentView, selectTask])

  const viewSwitcher = selectedKb ? (
    <Tabs
      value={currentView}
      onValueChange={value => onViewChange(value as KnowledgeView)}
      className="flex-shrink-0"
    >
      <TabsList className="h-8">
        <TabsTrigger value="documents" className="gap-1 h-7 px-2 text-xs">
          <FileText className="w-3.5 h-3.5" />
          {t('chatPage.documents')}
        </TabsTrigger>
        <TabsTrigger value="notebook" className="gap-1 h-7 px-2 text-xs">
          <Library className="w-3.5 h-3.5" />
          Notebook
        </TabsTrigger>
      </TabsList>
    </Tabs>
  ) : null

  // In Notebook view, show chat interface with document panel.
  // Simplified layout: direct left-right split without extra header bars
  if (selectedKb && currentView === 'notebook') {
    return (
      <div
        className="flex-1 flex flex-col bg-base overflow-hidden"
        data-testid="knowledge-detail-notebook"
      >
        <div className="flex items-center justify-end px-3 py-2 border-b border-border shrink-0">
          {viewSwitcher}
        </div>
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Chat area - left side */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <ChatArea
              teams={filteredTeams}
              isTeamsLoading={isTeamsLoading}
              showRepositorySelector={false}
              taskType="knowledge"
              knowledgeBaseId={selectedKb.id}
              onRefreshTeams={handleRefreshTeams}
              initialKnowledgeBase={{
                id: selectedKb.id,
                name: selectedKb.name,
                namespace: selectedKb.namespace,
                document_count: selectedKb.document_count,
              }}
              selectedDocumentIds={selectedDocumentIds}
              guidedQuestions={selectedKb.guided_questions}
              inputAlwaysAtBottom={true}
              emptyStateContent={
                <KnowledgeBaseSummaryCard
                  knowledgeBase={selectedKb}
                  onRefresh={handleRefreshKnowledgeBase}
                  canEditSummary={canManageKb}
                />
              }
              // Note: Knowledge base binding is handled by the backend when creating the task
              // via the knowledge_base_id parameter in the chat request.
            />
          </div>

          {/* Right panel - Document context selection */}
          <DocumentPanel
            knowledgeBase={selectedKb}
            canUpload={canUploadDocuments}
            canManageAllDocuments={canManageKb}
            canManagePermissions={canManagePermissions}
            onRefreshKnowledgeBase={handleRefreshKnowledgeBase}
            onDocumentSelectionChange={setSelectedDocumentIds}
            onCollapsedChange={setIsDocumentPanelCollapsed}
            groupInfo={groupInfo}
            onGroupClick={onGroupClick}
            initialDocPath={initialDocPath}
          />
        </div>
      </div>
    )
  }
  // In documents view, show document list.
  // Tabs are passed as headerActions to DocumentList so they appear in the same row as the title
  if (selectedKb) {
    // Build header actions (tabs) for permission management
    const headerActions = canManagePermissions ? (
      <Tabs
        value={activeTab}
        onValueChange={value => setActiveTab(value as 'documents' | 'permissions')}
        className="flex-shrink-0"
      >
        <TabsList className="h-8">
          <TabsTrigger value="documents" className="gap-1 h-7 px-2 text-xs">
            <FileText className="w-3.5 h-3.5" />
            {t('chatPage.documents')}
          </TabsTrigger>
          <TabsTrigger value="permissions" className="gap-1 h-7 px-2 text-xs">
            <Shield className="w-3.5 h-3.5" />
            {t('document.permission.management')}
          </TabsTrigger>
        </TabsList>
      </Tabs>
    ) : null

    return (
      <div
        className="flex-1 flex flex-col bg-base overflow-hidden"
        data-testid="knowledge-detail-classic"
      >
        {/* Content area */}
        <div className="flex-1 overflow-auto p-4 sm:p-6">
          {activeTab === 'documents' ? (
            <DocumentList
              knowledgeBase={selectedKb}
              canUpload={canUploadDocuments}
              canManageAllDocuments={canManageKb}
              paginationEnabled={true}
              onRefreshKnowledgeBase={handleRefreshKnowledgeBase}
              headerActions={
                <div className="flex items-center gap-2">
                  {headerActions}
                  {viewSwitcher}
                </div>
              }
              groupInfo={groupInfo}
              onGroupClick={onGroupClick}
              initialDocPath={initialDocPath}
            />
          ) : (
            <>
              {/* Show header with tabs when on permissions tab */}
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 min-w-0">
                  <h2 className="text-base font-medium text-text-primary truncate">
                    {selectedKb.name}
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {headerActions}
                  {viewSwitcher}
                </div>
              </div>
              <PermissionManagementTab kbId={selectedKb.id} kbNamespace={selectedKb.namespace} />
            </>
          )}
        </div>
      </div>
    )
  }

  // Empty state - no KB selected
  return (
    <div
      className="flex-1 flex items-center justify-center bg-base"
      data-testid="knowledge-detail-empty"
    >
      <div className="text-center max-w-sm px-6">
        <div className="w-16 h-16 bg-surface rounded-full flex items-center justify-center mx-auto mb-6">
          <Library className="w-8 h-8 text-text-muted opacity-60" />
        </div>
        <h2 className="text-base font-medium text-text-primary mb-2">
          {t('document.tree.emptyState')}
        </h2>
        <p className="text-sm text-text-muted">{t('document.tree.emptyStateHint')}</p>
      </div>
    </div>
  )
}
