// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeDetailPanel renders the right-side detail area for the selected knowledge base.
 *
 * - When no KB is selected: shows empty state
 * - When a notebook KB is selected: shows chat interface with document panel
 * - When a classic KB is selected: shows document list with management capabilities
 */

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Library, FileText, Shield } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { useTeamContext } from '@/contexts/TeamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
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
import type { KnowledgeBase } from '@/types/knowledge'
import type { Team } from '@/types/api'

interface KnowledgeDetailPanelProps {
  /** Currently selected knowledge base */
  selectedKb: KnowledgeBase | null
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
}

export function KnowledgeDetailPanel({
  selectedKb,
  isTreeCollapsed: _isTreeCollapsed,
  onExpandTree: _onExpandTree,
  onEditKb: _onEditKb,
  groupInfo,
  onGroupClick,
}: KnowledgeDetailPanelProps) {
  const { t } = useTranslation('knowledge')
  const { user } = useUser()

  // Task context - used to clear selected task when entering notebook mode
  const { setSelectedTask } = useTaskContext()

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

  // Determine KB type
  const isNotebook = selectedKb?.kb_type === 'notebook'

  // Reset state when KB changes
  // For notebook mode, also clear the selected task to show a fresh chat interface
  useEffect(() => {
    setActiveTab('documents')
    setSelectedDocumentIds([])
    setIsDocumentPanelCollapsed(false)

    // Clear selected task when entering notebook mode to prevent showing
    // a previously selected task from the tasks page
    if (selectedKb?.kb_type === 'notebook') {
      setSelectedTask(null)
    }
  }, [selectedKb?.id, selectedKb?.kb_type, setSelectedTask])

  // When a notebook KB is selected, show chat interface with document panel
  // Simplified layout: direct left-right split without extra header bars
  if (selectedKb && isNotebook) {
    return (
      <div className="flex-1 flex bg-base overflow-hidden" data-testid="knowledge-detail-notebook">
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
            emptyStateContent={<KnowledgeBaseSummaryCard knowledgeBase={selectedKb} />}
            // Note: Knowledge base binding is handled by the backend when creating the task
            // via the knowledge_base_id parameter in the chat request. No need to call
            // bindKnowledgeBase API here as it would either fail (not a group chat) or
            // be redundant (already bound).
          />
        </div>

        {/* Right panel - Document management */}
        <DocumentPanel
          knowledgeBase={selectedKb}
          canUpload={canUploadDocuments}
          canManageAllDocuments={canManageKb}
          canManagePermissions={canManagePermissions}
          onDocumentSelectionChange={setSelectedDocumentIds}
          onCollapsedChange={setIsDocumentPanelCollapsed}
          groupInfo={groupInfo}
          onGroupClick={onGroupClick}
        />
      </div>
    )
  }
  // When a classic KB is selected, show document list
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
              headerActions={headerActions}
              groupInfo={groupInfo}
              onGroupClick={onGroupClick}
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
                {headerActions}
              </div>
              <PermissionManagementTab kbId={selectedKb.id} />
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
