// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop implementation of Knowledge Document Page.
 *
 * Left tree panel + right detail area layout.
 * When a KB is selected, the tree collapses and navigates to the KB detail page.
 * When no KB is selected, shows empty state in the right panel.
 */

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { userApis } from '@/apis/user'
import { teamService } from '@/features/tasks/service/teamService'
import { saveGlobalModelPreference, type ModelPreference } from '@/utils/modelPreferences'
import { useKnowledgeTree } from '../hooks/useKnowledgeTree'
import { KnowledgeTreePanel } from './KnowledgeTreePanel'
import { KnowledgeDetailPanel } from './KnowledgeDetailPanel'
import { CreateKnowledgeBaseDialog } from './CreateKnowledgeBaseDialog'
import { EditKnowledgeBaseDialog } from './EditKnowledgeBaseDialog'
import { DeleteKnowledgeBaseDialog } from './DeleteKnowledgeBaseDialog'
import { ShareLinkDialog } from '../../permission/components/ShareLinkDialog'
import { CreateGroupChatFromKnowledgeDialog } from './CreateGroupChatFromKnowledgeDialog'
import type {
  KnowledgeBase,
  KnowledgeBaseCreate,
  KnowledgeBaseType,
  KnowledgeBaseUpdate,
  SummaryModelRef,
} from '@/types/knowledge'
import type { DefaultTeamsResponse, Team } from '@/types/api'
import type { Group } from '@/types/group'

export function KnowledgeDocumentPageDesktop() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Knowledge tree hook
  const tree = useKnowledgeTree()

  // Tree panel collapse state
  const [isTreeCollapsed, setIsTreeCollapsed] = useState(false)

  // Dialog states
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createScope, setCreateScope] = useState<'personal' | 'group' | 'organization'>('personal')
  const [createGroupName, setCreateGroupName] = useState<string | undefined>(undefined)
  const [createKbType, setCreateKbType] = useState<KnowledgeBaseType>('notebook')
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null)
  const [deletingKb, setDeletingKb] = useState<KnowledgeBase | null>(null)
  const [sharingKb, setSharingKb] = useState<KnowledgeBase | null>(null)

  // Group chat dialog
  const [showGroupChatDialog, setShowGroupChatDialog] = useState(false)
  const [groupChatContext, setGroupChatContext] = useState<{
    group: Group
    knowledgeBaseName?: string
    knowledgeBaseNamespace?: string
    knowledgeBases?: KnowledgeBase[]
  } | null>(null)

  // Default teams config for saving model preference
  const [defaultTeamsConfig, setDefaultTeamsConfig] = useState<DefaultTeamsResponse | null>(null)
  const [teams, setTeams] = useState<Team[]>([])

  // Load default teams config and teams list on mount
  useEffect(() => {
    const loadDefaultTeamsAndTeams = async () => {
      try {
        const [defaultTeamsRes, teamsRes] = await Promise.all([
          userApis.getDefaultTeams(),
          teamService.getTeams(),
        ])
        setDefaultTeamsConfig(defaultTeamsRes)
        setTeams(teamsRes.items || [])
      } catch (error) {
        console.error('Failed to load default teams config:', error)
      }
    }
    loadDefaultTeamsAndTeams()
  }, [])

  // Find knowledge mode default team ID
  const knowledgeDefaultTeamId = useMemo(() => {
    if (!defaultTeamsConfig?.knowledge || teams.length === 0) return null

    const { name, namespace } = defaultTeamsConfig.knowledge
    const normalizedNamespace = namespace || 'default'

    const matchedTeam = teams.find(team => {
      const teamNamespace = team.namespace || 'default'
      return team.name === name && teamNamespace === normalizedNamespace
    })

    return matchedTeam?.id ?? null
  }, [defaultTeamsConfig, teams])

  // Helper: save summary model to knowledge team's preference
  const saveSummaryModelToPreference = useCallback(
    (summaryModelRef: SummaryModelRef | null | undefined) => {
      if (!knowledgeDefaultTeamId || !summaryModelRef?.name) return

      const preference: ModelPreference = {
        modelName: summaryModelRef.name,
        modelType: summaryModelRef.type,
        forceOverride: true,
        updatedAt: Date.now(),
      }

      saveGlobalModelPreference(knowledgeDefaultTeamId, preference)
    },
    [knowledgeDefaultTeamId]
  )

  // Sync selected KB from URL parameter
  const { selectKb, selectedKbId: currentSelectedKbId } = tree
  useEffect(() => {
    const kbParam = searchParams.get('kb')
    if (kbParam) {
      const kbId = parseInt(kbParam, 10)
      if (!isNaN(kbId) && kbId !== currentSelectedKbId) {
        // Find KB in tree data and select it
        const allKbs = [
          ...(tree.personalData?.created_by_me || []),
          ...(tree.personalData?.shared_with_me || []),
          ...tree.orgKbs,
          ...Object.values(tree.groupKbMap).flat(),
        ]
        const found = allKbs.find(kb => kb.id === kbId)
        if (found) {
          selectKb(found)
          setIsTreeCollapsed(true)
        }
      }
    }
     
  }, [searchParams, tree.personalData, tree.orgKbs, tree.groupKbMap, currentSelectedKbId, selectKb])

  // Handle KB selection - navigate to detail page
  const handleSelectKb = useCallback(
    (kb: KnowledgeBase) => {
      tree.selectKb(kb)
      setIsTreeCollapsed(true)
      // Navigate to detail page
      router.push(`/knowledge/document/${kb.id}`)
    },
    [tree, router]
  )

  // Handle create KB
  const handleCreateKb = useCallback(
    (
      scope: 'personal' | 'group' | 'organization',
      kbType: KnowledgeBaseType,
      groupName?: string
    ) => {
      setCreateScope(scope)
      setCreateKbType(kbType)
      setCreateGroupName(groupName)
      setShowCreateDialog(true)
    },
    []
  )

  // Handle KB created
  const handleCreate = useCallback(
    async (data: Omit<KnowledgeBaseCreate, 'namespace' | 'kb_type'>) => {
      const namespace =
        createScope === 'organization'
          ? (tree.orgNamespace ?? 'organization')
          : createGroupName || 'default'

      // Use the appropriate API based on scope
      const { createKnowledgeBase } = await import('@/apis/knowledge')
      await createKnowledgeBase({
        name: data.name,
        description: data.description,
        namespace,
        retrieval_config: data.retrieval_config,
        summary_enabled: data.summary_enabled,
        summary_model_ref: data.summary_model_ref,
        kb_type: createKbType,
      })

      // Save model preference for notebook type
      if (createKbType === 'notebook' && data.summary_enabled && data.summary_model_ref) {
        saveSummaryModelToPreference(data.summary_model_ref)
      }

      setShowCreateDialog(false)

      // Refresh appropriate tree section
      if (createScope === 'organization') {
        await tree.refreshOrg()
      } else if (createGroupName) {
        await tree.refreshGroup(createGroupName)
      } else {
        await tree.refreshPersonal()
      }

      setCreateGroupName(undefined)
      setCreateScope('personal')
      setCreateKbType('notebook')
    },
    [createScope, createGroupName, createKbType, tree, saveSummaryModelToPreference]
  )

  // Handle KB updated
  const handleUpdate = useCallback(
    async (data: KnowledgeBaseUpdate) => {
      if (!editingKb) return

      const { updateKnowledgeBase } = await import('@/apis/knowledge')
      await updateKnowledgeBase(editingKb.id, data)

      if (editingKb.kb_type === 'notebook' && data.summary_enabled && data.summary_model_ref) {
        saveSummaryModelToPreference(data.summary_model_ref)
      }

      // Determine which section to refresh
      const isOrgKb = tree.orgNamespace
        ? editingKb.namespace === tree.orgNamespace
        : editingKb.namespace === 'organization'

      if (isOrgKb) {
        await tree.refreshOrg()
      } else if (editingKb.namespace !== 'default') {
        await tree.refreshGroup(editingKb.namespace)
      } else {
        await tree.refreshPersonal()
      }

      setEditingKb(null)
    },
    [editingKb, tree, saveSummaryModelToPreference]
  )

  // Handle KB deleted
  const handleDelete = useCallback(async () => {
    if (!deletingKb) return

    const { deleteKnowledgeBase } = await import('@/apis/knowledge')
    await deleteKnowledgeBase(deletingKb.id)

    const isOrgKb = tree.orgNamespace
      ? deletingKb.namespace === tree.orgNamespace
      : deletingKb.namespace === 'organization'

    if (isOrgKb) {
      await tree.refreshOrg()
    } else if (deletingKb.namespace !== 'default') {
      await tree.refreshGroup(deletingKb.namespace)
    } else {
      await tree.refreshPersonal()
    }

    // Clear selection if deleted KB was selected
    if (deletingKb.id === tree.selectedKbId) {
      tree.clearSelection()
      setIsTreeCollapsed(false)
    }

    setDeletingKb(null)
  }, [deletingKb, tree])

  // Handle group chat creation
  const handleCreateGroupChat = useCallback(
    (group: Group, kbInfo?: { name: string; namespace: string }, allKbs?: KnowledgeBase[]) => {
      setGroupChatContext({
        group,
        knowledgeBaseName: kbInfo?.name,
        knowledgeBaseNamespace: kbInfo?.namespace,
        knowledgeBases: allKbs,
      })
      setShowGroupChatDialog(true)
    },
    []
  )

  return (
    <div className="flex h-full" data-testid="knowledge-document-page">
      {/* Left tree panel */}
      <KnowledgeTreePanel
        nodes={tree.treeNodes}
        selectedKbId={tree.selectedKbId}
        loading={tree.loading}
        expandState={tree.expandState}
        onToggleExpand={tree.toggleExpand}
        onSelectKb={handleSelectKb}
        onCreateKb={handleCreateKb}
        onCreateGroupChat={handleCreateGroupChat}
        isAdmin={tree.isAdmin}
        isCollapsed={isTreeCollapsed}
        onCollapsedChange={setIsTreeCollapsed}
      />

      {/* Right detail panel */}
      <KnowledgeDetailPanel selectedKb={null} />

      {/* Dialogs */}
      <CreateKnowledgeBaseDialog
        open={showCreateDialog}
        onOpenChange={open => {
          setShowCreateDialog(open)
          if (!open) {
            setCreateGroupName(undefined)
            setCreateScope('personal')
            setCreateKbType('notebook')
          }
        }}
        onSubmit={handleCreate}
        loading={false}
        scope={createScope}
        groupName={createGroupName}
        kbType={createKbType}
        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
      />

      <EditKnowledgeBaseDialog
        open={!!editingKb}
        onOpenChange={open => !open && setEditingKb(null)}
        knowledgeBase={editingKb}
        onSubmit={handleUpdate}
        loading={false}
        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
      />

      <DeleteKnowledgeBaseDialog
        open={!!deletingKb}
        onOpenChange={open => !open && setDeletingKb(null)}
        knowledgeBase={deletingKb}
        onConfirm={handleDelete}
        loading={false}
      />

      <ShareLinkDialog
        open={!!sharingKb}
        onOpenChange={open => !open && setSharingKb(null)}
        kbId={sharingKb?.id || 0}
        kbName={sharingKb?.name || ''}
      />

      {groupChatContext && (
        <CreateGroupChatFromKnowledgeDialog
          open={showGroupChatDialog}
          onOpenChange={open => {
            setShowGroupChatDialog(open)
            if (!open) {
              setGroupChatContext(null)
            }
          }}
          group={groupChatContext.group}
          knowledgeBaseName={groupChatContext.knowledgeBaseName}
          knowledgeBaseNamespace={groupChatContext.knowledgeBaseNamespace}
          knowledgeBases={groupChatContext.knowledgeBases}
        />
      )}
    </div>
  )
}
