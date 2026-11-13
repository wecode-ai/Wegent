// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useKnowledgeBaseDialogs - Hook for managing knowledge base dialog states and handlers.
 *
 * Encapsulates create, edit, delete, and migrate dialog logic to keep the
 * page component focused on layout and navigation.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import client from '@/apis/client'
import type { AvailableGroup } from '../components/CreateKnowledgeBaseDialog'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { migrateKnowledgeBaseToGroup } from '@/apis/knowledge'
import { createCodeWiki } from '@/features/knowledge/code-wiki/createCodeWiki'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  KnowledgeBase,
  KnowledgeBaseCreate,
  KnowledgeBaseType,
  KnowledgeBaseUpdate,
} from '@/types/knowledge'
import { PERSONAL_SPACE_FILTER } from '../navigation'
import type { MigrationTargetGroup } from '../components/MigrateKnowledgeBaseDialog'

interface SidebarLike {
  groups: Array<{ id: string; name: string; displayName: string; type: string }>
  filterGroupId?: string | null
  listRevision?: number
  selectedGroupId: string | null
  currentUser: { id: number } | null
  selectedKbId: number | null
  refreshAll: () => Promise<void>
  clearSelection: () => void
}

interface UseKnowledgeBaseDialogsParams {
  sidebar: SidebarLike
  availableGroups?: AvailableGroup[]
}

export type CreatedKnowledgeBase = Pick<KnowledgeBase, 'id' | 'name' | 'namespace'>

export interface UseKnowledgeBaseDialogsReturn {
  createdKb: CreatedKnowledgeBase | null
  createRefreshError: string | null
  dismissCreatedKb: () => void
  retryCreatedList: () => Promise<void>
  defaultCreateGroupId: string
  // Create dialog
  showCreateDialog: boolean
  setShowCreateDialog: (show: boolean) => void
  createScope: 'personal' | 'group' | 'organization'
  setCreateScope: (scope: 'personal' | 'group' | 'organization') => void
  createGroupName: string | undefined
  setCreateGroupName: (name: string | undefined) => void
  createKbType: KnowledgeBaseType
  setCreateKbType: (type: KnowledgeBaseType) => void
  showGroupSelector: boolean
  setShowGroupSelector: (show: boolean) => void
  isCreating: boolean
  createError: string | null

  // Edit dialog
  editingKb: KnowledgeBase | null
  setEditingKb: (kb: KnowledgeBase | null) => void
  isUpdating: boolean

  // Delete dialog
  deletingKb: KnowledgeBase | null
  setDeletingKb: (kb: KnowledgeBase | null) => void
  isDeleting: boolean

  // Migrate dialog
  migratingKb: KnowledgeBase | null
  setMigratingKb: (kb: KnowledgeBase | null) => void
  isMigrating: boolean
  availableMigrationGroups: MigrationTargetGroup[]

  // Handlers
  handleCreate: (
    data: Omit<KnowledgeBaseCreate, 'namespace'> & { selectedGroupId?: string }
  ) => Promise<void>
  handleUpdate: (data: KnowledgeBaseUpdate) => Promise<void>
  handleDelete: () => Promise<void>
  handleMigrate: (targetGroupName: string) => Promise<void>
  handleCreateKbFromAll: (kbType: KnowledgeBaseType) => void
  handleCreateKbFromGroups: (kbType: KnowledgeBaseType) => void
  handleCreateKbFromGroup: (kbType: KnowledgeBaseType) => void
  canMigrateKb: (kb: { id: number; namespace: string; user_id: number }) => boolean
  resetCreateDialogState: () => void
}

export function useKnowledgeBaseDialogs({
  sidebar,
  availableGroups,
}: UseKnowledgeBaseDialogsParams): UseKnowledgeBaseDialogsReturn {
  const cacheScope = client.getCacheScope()
  const scope = JSON.stringify([sidebar.currentUser?.id, cacheScope])
  const generation = useRef(0)
  const [stateScope, setStateScope] = useState(scope)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const latest = useRef({ sidebar, availableGroups })
  latest.current = { sidebar, availableGroups }
  const createdRef = useRef<CreatedKnowledgeBase | null>(null)
  const creatingRef = useRef(false)
  const [createdKb, setCreatedKb] = useState<CreatedKnowledgeBase | null>(null)
  const [createRefreshError, setCreateRefreshError] = useState<string | null>(null)
  const [defaultCreateGroupId, setDefaultCreateGroupId] = useState('personal')

  const router = useRouter()
  const { t } = useTranslation('knowledge')

  // Create dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createScope, setCreateScope] = useState<'personal' | 'group' | 'organization'>('personal')
  const [createGroupName, setCreateGroupName] = useState<string | undefined>(undefined)
  const [createKbType, setCreateKbType] = useState<KnowledgeBaseType>('notebook')
  const [showGroupSelector, setShowGroupSelector] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  // Edit dialog state
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)

  // Delete dialog state
  const [deletingKb, setDeletingKb] = useState<KnowledgeBase | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Migrate dialog state
  const [migratingKb, setMigratingKb] = useState<KnowledgeBase | null>(null)
  const [isMigrating, setIsMigrating] = useState(false)

  const resetCreateDialogState = useCallback(() => {
    setCreateGroupName(undefined)
    setCreateScope('personal')
    setCreateKbType('notebook')
    setShowGroupSelector(false)
  }, [])

  const [createError, setCreateError] = useState<string | null>(null)

  if (stateScope !== scope) {
    generation.current++
    setStateScope(scope)
    createdRef.current = null
    creatingRef.current = false
    setCreatedKb(null)
    setShowCreateDialog(false)
    setIsCreating(false)
    setCreateRefreshError(null)
    setCreateError(null)
    setEditingKb(null)
    setDeletingKb(null)
    setMigratingKb(null)
    resetCreateDialogState()
  }
  const epoch = generation.current
  const dismissCreatedKb = useCallback(() => {
    if (scopeRef.current !== scope || generation.current !== epoch) return
    createdRef.current = null
    setCreatedKb(null)
    setCreateRefreshError(null)
  }, [scope, epoch])

  const retryCreatedList = useCallback(async () => {
    const current = () =>
      mounted.current &&
      scopeRef.current === scope &&
      generation.current === epoch &&
      client.getCacheScope() === cacheScope
    if (!current()) return
    setCreateRefreshError(null)
    try {
      await latest.current.sidebar.refreshAll()
    } catch (error) {
      if (current()) setCreateRefreshError(error instanceof Error ? error.message : String(error))
    }
  }, [scope, cacheScope, epoch])

  const handleCreate = useCallback(
    async (data: Omit<KnowledgeBaseCreate, 'namespace'> & { selectedGroupId?: string }) => {
      if (
        creatingRef.current ||
        client.getCacheScope() !== cacheScope ||
        createdRef.current ||
        scopeRef.current !== scope ||
        generation.current !== epoch ||
        !mounted.current
      )
        return
      creatingRef.current = true
      const current = () =>
        mounted.current &&
        scopeRef.current === scope &&
        generation.current === epoch &&
        client.getCacheScope() === cacheScope
      const completed = (created: CreatedKnowledgeBase) => {
        if (!current()) return
        createdRef.current = created
        setCreatedKb(created)
        setShowCreateDialog(false)
        resetCreateDialogState()
        void retryCreatedList()
      }
      setCreateRefreshError(null)
      setIsCreating(true)
      setCreateError(null)
      try {
        let namespace = 'default'

        if (data.selectedGroupId) {
          const selectedGroup = latest.current.availableGroups?.find(
            g => g.id === data.selectedGroupId
          )
          if (!selectedGroup) {
            throw new Error(`Selected group ${data.selectedGroupId} not found`)
          }
          if (selectedGroup.type === 'personal' && selectedGroup.id !== 'personal')
            throw new Error(t('document.creation.spaceUnavailable'))
          if (selectedGroup.type === 'personal') {
            namespace = 'default'
          } else {
            namespace = selectedGroup.name
          }
        } else if (createScope === 'organization') {
          const orgGroup = sidebar.groups.find(g => g.type === 'organization')
          if (!orgGroup) {
            throw new Error('Organization group not found')
          }
          namespace = orgGroup.name
        } else if (createGroupName) {
          namespace = createGroupName
        }

        if (
          namespace !== 'default' &&
          !latest.current.availableGroups?.some(
            group => group.name === namespace && group.canCreate
          )
        )
          throw new Error(t('document.creation.spaceUnavailable'))
        const kbType = data.kb_type || createKbType

        // A code wiki is created through its own endpoint: it needs a repository,
        // passes a repository-access gate, and starts generating straight away.
        // Everything after that point is the same knowledge base as any other.
        if (kbType === 'code_wiki') {
          // The whole payload, not the repository fields plus whatever was
          // remembered: a code wiki is an ordinary knowledge base with a repository
          // attached, and hand-picking here is what dropped the summary settings and
          // left the retrieval config to be auto-resolved instead of taken from the
          // form. `data` already carries every field the dialog collected.
          const created = await createCodeWiki({
            isCurrent: current,
            namespace,
            data,
          })
          completed({ id: created.id, name: created.name, namespace })
          if (!current()) return
          if (created.scheduledUpdateError) {
            toast.warning(t('codeWiki.create.scheduleNotConfigured'))
          } else {
            toast.success(t('codeWiki.create.created'))
          }
          return
        }

        const { createKnowledgeBase } = await import('@/apis/knowledge')
        if (!current()) return
        const created = await createKnowledgeBase({
          name: data.name,
          description: data.description,
          namespace,
          direct_access_requirement: data.direct_access_requirement,
          allow_document_download: data.allow_document_download,
          retrieval_config: data.retrieval_config,
          rag_config_mode: data.rag_config_mode,
          dingtalk_auto_sync_enabled: data.dingtalk_auto_sync_enabled,
          summary_enabled: data.summary_enabled,
          summary_model_ref: data.summary_model_ref,
          kb_type: kbType,
          guided_questions: data.guided_questions,
          max_calls_per_conversation: data.max_calls_per_conversation,
          exempt_calls_before_check: data.exempt_calls_before_check,
          // Forward multimodal config assembled by the dialog —
          // buildMultimodalSubmitFields() already set these in the dialog;
          // omitting them here silently dropped the toggle on create, while
          // handleUpdate passed `data` through unchanged (so edit worked).
          multimodal_analysis_enabled: data.multimodal_analysis_enabled,
          multimodal_analysis_model_ref: data.multimodal_analysis_model_ref,
          multimodal_analysis_video_prompt: data.multimodal_analysis_video_prompt,
          multimodal_analysis_image_prompt: data.multimodal_analysis_image_prompt,
        })

        completed({ id: created.id, name: created.name, namespace: created.namespace })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create knowledge base'
        if (current()) setCreateError(message)
        throw err
      } finally {
        if (current()) {
          creatingRef.current = false
          setIsCreating(false)
        }
      }
    },
    [
      createScope,
      createGroupName,
      createKbType,
      sidebar,
      scope,
      cacheScope,
      epoch,
      resetCreateDialogState,
      retryCreatedList,
      t,
    ]
  )

  const handleUpdate = useCallback(
    async (data: KnowledgeBaseUpdate) => {
      if (!editingKb) return
      setIsUpdating(true)
      try {
        const { updateKnowledgeBase } = await import('@/apis/knowledge')
        await updateKnowledgeBase(editingKb.id, data)

        await sidebar.refreshAll()
      } finally {
        setIsUpdating(false)
      }
    },
    [editingKb, sidebar]
  )

  const handleDelete = useCallback(async () => {
    if (!deletingKb) return
    setIsDeleting(true)
    try {
      const { deleteKnowledgeBase } = await import('@/apis/knowledge')
      await deleteKnowledgeBase(deletingKb.id)

      await sidebar.refreshAll()

      if (deletingKb.id === sidebar.selectedKbId) {
        sidebar.clearSelection()
        router.push('/knowledge?type=document')
      }

      setDeletingKb(null)
    } finally {
      setIsDeleting(false)
    }
  }, [deletingKb, sidebar, router])

  const handleMigrate = useCallback(
    async (targetGroupName: string) => {
      if (!migratingKb) return
      setIsMigrating(true)
      try {
        await migrateKnowledgeBaseToGroup(migratingKb.id, targetGroupName)
        await sidebar.refreshAll()

        if (migratingKb.id === sidebar.selectedKbId) {
          sidebar.clearSelection()
          router.push('/knowledge?type=document')
        }

        setMigratingKb(null)
      } catch (error) {
        throw error
      } finally {
        setIsMigrating(false)
      }
    },
    [migratingKb, sidebar, router]
  )

  const handleCreateKbFromAll = useCallback(
    (kbType: KnowledgeBaseType) => {
      const filter = latest.current.sidebar.filterGroupId
      setDefaultCreateGroupId(filter === PERSONAL_SPACE_FILTER ? 'personal' : filter || 'personal')
      dismissCreatedKb()
      setCreateScope('personal')
      setCreateGroupName(undefined)
      setCreateKbType(kbType)
      setShowGroupSelector(true)
      setShowCreateDialog(true)
    },
    [dismissCreatedKb]
  )

  const handleCreateKbFromGroups = useCallback((kbType: KnowledgeBaseType) => {
    setCreateScope('group')
    setCreateGroupName(undefined)
    setCreateKbType(kbType)
    setShowGroupSelector(true)
    setShowCreateDialog(true)
  }, [])

  const handleCreateKbFromGroup = useCallback(
    (kbType: KnowledgeBaseType) => {
      const selectedGroup = sidebar.groups.find(g => g.id === sidebar.selectedGroupId)
      if (!selectedGroup) return

      if (selectedGroup.type === 'personal') {
        setCreateScope('personal')
        setCreateGroupName(undefined)
      } else if (selectedGroup.type === 'organization') {
        setCreateScope('organization')
        setCreateGroupName(undefined)
      } else {
        setCreateScope('group')
        setCreateGroupName(selectedGroup.name)
      }
      setCreateKbType(kbType)
      setShowCreateDialog(true)
    },
    [sidebar.groups, sidebar.selectedGroupId]
  )

  const canMigrateKb = useCallback(
    (kb: { id: number; namespace: string; user_id: number }) => {
      if (kb.namespace !== 'default') return false
      return kb.user_id === sidebar.currentUser?.id
    },
    [sidebar.currentUser]
  )

  const availableMigrationGroups = useMemo((): MigrationTargetGroup[] => {
    return sidebar.groups
      .filter(g => g.type === 'group' || g.type === 'organization')
      .map(g => ({
        id: g.id,
        name: g.name,
        displayName: g.displayName,
        type: g.type as 'group' | 'organization',
      }))
  }, [sidebar.groups])

  return {
    createdKb,
    createRefreshError,
    dismissCreatedKb,
    retryCreatedList,
    defaultCreateGroupId,
    showCreateDialog,
    setShowCreateDialog,
    createScope,
    setCreateScope,
    createGroupName,
    setCreateGroupName,
    createKbType,
    setCreateKbType,
    showGroupSelector,
    setShowGroupSelector,
    isCreating,
    createError,
    editingKb,
    setEditingKb,
    isUpdating,
    deletingKb,
    setDeletingKb,
    isDeleting,
    migratingKb,
    setMigratingKb,
    isMigrating,
    availableMigrationGroups,
    handleCreate,
    handleUpdate,
    handleDelete,
    handleMigrate,
    handleCreateKbFromAll,
    handleCreateKbFromGroups,
    handleCreateKbFromGroup,
    canMigrateKb,
    resetCreateDialogState,
  }
}
