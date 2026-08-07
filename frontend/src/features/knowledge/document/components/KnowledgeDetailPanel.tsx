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
import { Files, Library, FileText, MessageSquare, Shield, WandSparkles } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'
import { useUser } from '@/features/common/UserContext'
import { useTeamContext } from '@/contexts/TeamContext'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { ChatArea } from '@/features/tasks/components/chat'
import { DocumentList, type KbGroupInfo } from './DocumentList'
import { KnowledgeSourcePanel } from './KnowledgeSourcePanel'
import { knowledgeCapableTeams } from '../utils/knowledgeTeams'
import { KnowledgeBaseSummaryCard } from './KnowledgeBaseSummaryCard'
import { ArtifactWorkspacePanel } from '@/features/knowledge/artifact/components/ArtifactWorkspacePanel'
import { ArtifactSourceDialog } from '@/features/knowledge/artifact/components/ArtifactSourceDialog'
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
import type { ArtifactPromptRequest } from '@/types/knowledge-artifact'
import type { KnowledgeCapabilityDraftRequest } from '@/types/knowledge-capability'
import { getTaskQueryParam } from '@/features/tasks/utils/task-query-params'

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
  const [availableDocumentCount, setAvailableDocumentCount] = useState<number | null>(null)
  const [sourceRefreshToken, setSourceRefreshToken] = useState(0)
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const sourceApplyContinuationRef = useRef<(() => void) | null>(null)
  const [mobileWorkspaceTab, setMobileWorkspaceTab] = useState<'sources' | 'chat' | 'generation'>(
    'chat'
  )
  const [artifactPromptRequest, setArtifactPromptRequest] = useState<ArtifactPromptRequest | null>(
    null
  )
  const [capabilityDraftRequest, setCapabilityDraftRequest] =
    useState<KnowledgeCapabilityDraftRequest | null>(null)

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

  const filteredTeams = useMemo(() => knowledgeCapableTeams(teams), [teams])

  // Handle refresh teams
  const handleRefreshTeams = useCallback(async (): Promise<Team[]> => {
    return await refreshTeams()
  }, [refreshTeams])

  const handleRefreshKnowledgeBase = useCallback(async () => {
    if (!selectedKb || !onSyncKnowledgeBase) return
    const nextKb = await getKnowledgeBase(selectedKb.id)
    onSyncKnowledgeBase(nextKb)
  }, [selectedKb, onSyncKnowledgeBase])

  const openSourceDialog = useCallback((onApplied?: () => void) => {
    sourceApplyContinuationRef.current = onApplied ?? null
    setSourceDialogOpen(true)
  }, [])

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
    const fromSearchParams = getTaskQueryParam(searchParams)
    if (fromSearchParams) return fromSearchParams
    // Fallback for replaceState scenarios where useSearchParams hasn't synced yet
    if (typeof window !== 'undefined') {
      const browserParams = new URLSearchParams(window.location.search)
      return getTaskQueryParam(browserParams)
    }
    return null
  }, [searchParams])
  const initialDocumentId = useMemo(() => {
    const rawId = searchParams.get('documentId')
    if (!rawId) return undefined

    const documentId = Number(rawId)
    return Number.isInteger(documentId) && documentId > 0 ? documentId : undefined
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
    const isKbSwitch = prevKbIdRef.current !== null && prevKbIdRef.current !== selectedKb?.id
    const isInitialKnowledgeBase = prevKbIdRef.current === null && selectedKb?.id != null

    if (isInitialKnowledgeBase || isKbSwitch) {
      setActiveTab('documents')
      setSelectedDocumentIds([])
      setAvailableDocumentCount(null)
      setSourceDialogOpen(false)
      sourceApplyContinuationRef.current = null
      setMobileWorkspaceTab('chat')
      setArtifactPromptRequest(null)
      setCapabilityDraftRequest(null)
    }

    if (currentView === 'documents') {
      selectTask(null)
    }

    if (currentView === 'notebook') {
      if (isKbSwitch || !taskIdFromUrlRef.current) {
        selectTask(null)
      }
    }

    if (selectedKb?.id != null) {
      prevKbIdRef.current = selectedKb.id
    }
  }, [selectedKb?.id, currentView, selectTask])

  // In Notebook view, organize the workflow as sources -> conversation -> generation.
  if (selectedKb && currentView === 'notebook') {
    return (
      <div
        className="flex flex-1 flex-col overflow-hidden border-t border-border bg-base lg:flex-row"
        data-testid="knowledge-detail-notebook"
      >
        <Tabs
          value={mobileWorkspaceTab}
          onValueChange={value => setMobileWorkspaceTab(value as 'sources' | 'chat' | 'generation')}
          className="border-b border-border p-2 lg:hidden"
        >
          <TabsList className="grid h-11 w-full grid-cols-3">
            <TabsTrigger
              value="sources"
              className="h-11"
              data-testid="knowledge-mobile-sources-tab"
            >
              <Files className="mr-1.5 h-4 w-4" />
              {t('artifact.mobile.sources')}
            </TabsTrigger>
            <TabsTrigger value="chat" className="h-11" data-testid="knowledge-mobile-chat-tab">
              <MessageSquare className="mr-1.5 h-4 w-4" />
              {t('artifact.mobile.chat')}
            </TabsTrigger>
            <TabsTrigger
              value="generation"
              className="h-11"
              data-testid="knowledge-mobile-generation-tab"
            >
              <WandSparkles className="mr-1.5 h-4 w-4" />
              {t('artifact.mobile.generation')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <KnowledgeSourcePanel
          key={`sources-${selectedKb.id}`}
          knowledgeBase={selectedKb}
          selectedDocumentIds={selectedDocumentIds}
          availableDocumentCount={availableDocumentCount}
          canUploadDocuments={canUploadDocuments}
          canManageAllDocuments={canManageKb}
          mobileVisible={mobileWorkspaceTab === 'sources'}
          refreshToken={sourceRefreshToken}
          groupInfo={groupInfo}
          onGroupClick={onGroupClick}
          isOrganization={groupInfo?.groupType === 'organization'}
          initialDocPath={initialDocPath}
          initialDocumentId={initialDocumentId}
          onDocumentSelectionChange={setSelectedDocumentIds}
          onRefreshKnowledgeBase={handleRefreshKnowledgeBase}
          onSourcesChanged={() => setSourceRefreshToken(current => current + 1)}
        />

        <div
          className={`${mobileWorkspaceTab === 'chat' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col lg:flex`}
          data-testid="knowledge-workspace-chat"
        >
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
            externalPromptRequest={artifactPromptRequest}
            onExternalPromptConsumed={requestId => {
              setArtifactPromptRequest(current =>
                current?.requestId === requestId ? null : current
              )
            }}
            externalDraftRequest={capabilityDraftRequest}
            onExternalDraftConsumed={requestId => {
              setCapabilityDraftRequest(current =>
                current?.requestId === requestId ? null : current
              )
            }}
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

        <ArtifactWorkspacePanel
          key={`generation-${selectedKb.id}`}
          knowledgeBaseId={selectedKb.id}
          selectedDocumentIds={selectedDocumentIds}
          refreshToken={sourceRefreshToken}
          mobileVisible={mobileWorkspaceTab === 'generation'}
          onAdjustSources={openSourceDialog}
          onAvailableDocumentCountChange={setAvailableDocumentCount}
          onAskNode={request => {
            setArtifactPromptRequest(request)
            setMobileWorkspaceTab('chat')
          }}
          onCreatePptDraft={() => {
            setCapabilityDraftRequest({
              requestId: `presentation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              message: t('artifact.presentationPrompt'),
            })
            setMobileWorkspaceTab('chat')
          }}
        />

        <ArtifactSourceDialog
          knowledgeBaseId={selectedKb.id}
          open={sourceDialogOpen}
          selectedDocumentIds={selectedDocumentIds}
          availableDocumentCount={availableDocumentCount}
          onOpenChange={setSourceDialogOpen}
          onApply={documentIds => {
            const continuation = sourceApplyContinuationRef.current
            setSelectedDocumentIds(documentIds)
            sourceApplyContinuationRef.current = null
            continuation?.()
          }}
        />
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
              headerActions={headerActions}
              groupInfo={groupInfo}
              onGroupClick={onGroupClick}
              initialDocPath={initialDocPath}
              initialDocumentId={initialDocumentId}
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
