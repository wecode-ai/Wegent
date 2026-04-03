// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Mobile implementation of Knowledge Document Page.
 *
 * Full-screen switch mode:
 * - Default: full-screen knowledge tree list
 * - After selecting a KB: navigates to the KB detail page
 * - Uses ArrowLeft to go back
 */

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { userApis } from '@/apis/user'
import { teamService } from '@/features/tasks/service/teamService'
import { saveGlobalModelPreference, type ModelPreference } from '@/utils/modelPreferences'
import { canManageNamespace } from '@/utils/namespace-permissions'
import { useKnowledgeTree } from '../hooks/useKnowledgeTree'
import { KnowledgeTree } from './KnowledgeTree'
import { CreateKnowledgeBaseDialog } from './CreateKnowledgeBaseDialog'
import type {
  KnowledgeBase,
  KnowledgeBaseCreate,
  KnowledgeBaseType,
  SummaryModelRef,
} from '@/types/knowledge'
import type { DefaultTeamsResponse, Team } from '@/types/api'
import type { Group } from '@/types/group'

export function KnowledgeDocumentPageMobile() {
  const router = useRouter()

  // Knowledge tree hook
  const tree = useKnowledgeTree()

  // Dialog states
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createScope, setCreateScope] = useState<'personal' | 'group' | 'organization'>('personal')
  const [createGroupName, setCreateGroupName] = useState<string | undefined>(undefined)
  const [createKbType, setCreateKbType] = useState<KnowledgeBaseType>('notebook')
  const [isCreating, setIsCreating] = useState(false)

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

  // Handle KB selection - navigate to detail page (full screen on mobile)
  const handleSelectKb = useCallback(
    (kb: KnowledgeBase) => {
      tree.selectKb(kb)
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
    async (data: Omit<KnowledgeBaseCreate, 'namespace'>) => {
      setIsCreating(true)
      try {
        const namespace =
          createScope === 'organization'
            ? (tree.orgNamespace ?? 'organization')
            : createGroupName || 'default'

        // Use kb_type from dialog (user can change it in the dialog)
        const kbType = data.kb_type || createKbType

        const { createKnowledgeBase } = await import('@/apis/knowledge')
        await createKnowledgeBase({
          name: data.name,
          description: data.description,
          namespace,
          retrieval_config: data.retrieval_config,
          summary_enabled: data.summary_enabled,
          summary_model_ref: data.summary_model_ref,
          kb_type: kbType,
          guided_questions: data.guided_questions,
          max_calls_per_conversation: data.max_calls_per_conversation,
          exempt_calls_before_check: data.exempt_calls_before_check,
        })

        if (kbType === 'notebook' && data.summary_enabled && data.summary_model_ref) {
          saveSummaryModelToPreference(data.summary_model_ref)
        }

        setShowCreateDialog(false)

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
      } finally {
        setIsCreating(false)
      }
    },
    [createScope, createGroupName, createKbType, tree, saveSummaryModelToPreference]
  )

  // Handle open group settings
  const handleOpenGroupSettings = useCallback((group: Group) => {
    // Navigate to group settings page
    window.location.href = `/settings?section=groups&tab=group-team&group=${encodeURIComponent(group.name)}`
  }, [])

  const canManageGroup = useCallback(
    (group: Group) =>
      canManageNamespace({
        namespaceRole: group.my_role,
      }),
    []
  )

  return (
    <div className="flex flex-col h-full" data-testid="knowledge-document-page-mobile">
      {/* Full-screen knowledge tree */}
      <KnowledgeTree
        nodes={tree.treeNodes}
        selectedKbId={tree.selectedKbId}
        loading={tree.loading}
        expandState={tree.expandState}
        onToggleExpand={tree.toggleExpand}
        onSelectKb={handleSelectKb}
        onCreateKb={handleCreateKb}
        onOpenGroupSettings={handleOpenGroupSettings}
        canManageGroup={canManageGroup}
      />

      {/* Dialogs */}
      {/* Dialogs */}
      <CreateKnowledgeBaseDialog
        open={showCreateDialog}
        onOpenChange={open => {
          if (!isCreating) {
            setShowCreateDialog(open)
            if (!open) {
              setCreateGroupName(undefined)
              setCreateScope('personal')
              setCreateKbType('notebook')
            }
          }
        }}
        onSubmit={handleCreate}
        loading={isCreating}
        scope={createScope}
        groupName={createGroupName}
        kbType={createKbType}
        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
      />
    </div>
  )
}
