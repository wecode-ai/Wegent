// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  fetchUnifiedSkillsList,
  getSkill,
  fetchMyDefaultSkillBindings,
  type SkillBinding,
  type UnifiedSkill,
  deleteSkill,
  downloadSkill,
  fetchSkillReferences,
  removeSkillReferences,
  removeSingleSkillReference,
  parseSkillReferenceError,
  ReferencedGhost,
  updateSkillFromGit,
  batchUpdateSkillsFromGit,
  addSkillToMyDefault,
  removeSkillFromMyDefault,
} from '@/apis/skills'
import { checkSkillMarketAvailable, SkillMarketAvailability } from '@/apis/skillMarket'
import { getGroup } from '@/apis/groups'
import { Group } from '@/types/group'
import { canDelete, canEditContent } from '@/types/base-role'
import { filterVisibleSkills } from '@/utils/skillVisibility'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ResourceListItem } from '@/components/common/ResourceListItem'
import {
  ResourceCardIcon,
  getResourceCardActionsClassName,
  getResourceCardBodyClassName,
  getResourceCardClassName,
  getResourceGridClassName,
} from '@/components/common/resourceCardLayout'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import {
  Download,
  Trash2,
  Sparkles,
  RefreshCw,
  ExternalLink,
  Link2,
  MoreHorizontal,
  Pencil,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react'
import { toast } from 'sonner'
import SkillUploadModal from './skills/SkillUploadModal'
import SkillSearchModal from './skills/SkillSearchModal'
import { SkillReferenceConflictDialog } from './skills/SkillReferenceConflictDialog'
import { AutoEnabledSkillConfigDialog } from './skills/AutoEnabledSkillConfigDialog'
import { InstalledSkillCard } from './skills/InstalledSkillCard'
import { useUser } from '@/features/common/UserContext'
import { cn } from '@/lib/utils'
import type { ManagedResourceSourceFilter } from '@/features/resource-library/types'
import {
  buildGroupDisplayNameMap,
  filterResourceLibraryItemsByGroups,
  sortResourceLibraryItems,
  type ResourceLibrarySortMode,
  type ResourceLibrarySortSource,
} from '@/features/resource-library/resourceSorting'
import { matchesResourceSearch } from '@/features/resource-library/resourceSearch'
import {
  ResourceCreateButton,
  type ResourceCreateTarget,
  type ResourceCreateRequest,
} from '@/features/resource-library/components/ResourceCreateButton'
import { ResourceManagementLayout } from './resource-management/ResourceManagementLayout'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { SkillShareScopeDialog } from '@/features/resource-library/components/SkillShareScopeDialog'
import { PublishedResourceIndicator } from '@/features/resource-library/components/PublishedResourceIndicator'

interface SkillListWithScopeProps {
  scope: 'personal' | 'group' | 'all'
  selectedGroup?: string | null
  onGroupChange?: (groupName: string | null) => void
  sourceControls?: ReactNode
  sortControls?: ReactNode
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
  groupFilter?: string[]
  sortMode?: ResourceLibrarySortMode
  createRequest?: ResourceCreateRequest
  onCreated?: (skillId?: number) => void
  onCreateRequestClose?: () => void
  creationOnly?: boolean
  showAutoEnabledSkills?: boolean
  hideCreateActions?: boolean
  compact?: boolean
  searchQuery?: string
}

function normalizeSkillCreateTarget(target: ResourceCreateTarget): ResourceCreateTarget {
  if (target.scope !== 'group' || !target.groupName || target.groupNames?.length) {
    return target
  }
  return { ...target, groupNames: [target.groupName] }
}

function isSystemSkill(skill: UnifiedSkill): boolean {
  return skill.user_id === 0
}

export function SkillListWithScope({
  scope,
  selectedGroup,
  sourceControls,
  sortControls,
  sourceFilter = 'all',
  groups = [],
  groupFilter,
  sortMode = 'default',
  createRequest,
  onCreated,
  onCreateRequestClose,
  creationOnly = false,
  showAutoEnabledSkills = true,
  hideCreateActions = false,
  compact = false,
  searchQuery = '',
}: SkillListWithScopeProps) {
  const { t } = useTranslation('common')
  const { t: tSettingsBase } = useTranslation('settings')
  const tSettings = useCallback(
    (key: string, options?: Record<string, unknown>) => tSettingsBase(key, options),
    [tSettingsBase]
  )
  const { user } = useUser()
  const [librarySkills, setLibrarySkills] = useState<UnifiedSkill[]>([])
  const [publishedSkillIds, setPublishedSkillIds] = useState<Set<number>>(new Set())
  const [allAvailableSkills, setAllAvailableSkills] = useState<UnifiedSkill[]>([])
  const [autoEnabledBindings, setAutoEnabledBindings] = useState<SkillBinding[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [skillToDelete, setSkillToDelete] = useState<UnifiedSkill | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<UnifiedSkill | null>(null)
  const [shareScopeSkill, setShareScopeSkill] = useState<UnifiedSkill | null>(null)
  const [searchModalOpen, setSearchModalOpen] = useState(false)
  const [configuringSkill, setConfiguringSkill] = useState<UnifiedSkill | null>(null)
  const [createTarget, setCreateTarget] = useState<ResourceCreateTarget>({ scope: 'personal' })
  const [currentGroup, setCurrentGroup] = useState<Group | null>(null)
  const [updatingFromGitId, setUpdatingFromGitId] = useState<number | null>(null)
  const [updatingDefaultSkillId, setUpdatingDefaultSkillId] = useState<number | null>(null)
  const [updatingAllFromGit, setUpdatingAllFromGit] = useState(false)
  const [updateAllConfirmOpen, setUpdateAllConfirmOpen] = useState(false)
  const [updateAllProgress, setUpdateAllProgress] = useState<{
    total: number
    current: number
    currentSkillName: string
    success: number
    failed: number
  } | null>(null)
  const handledCreateRequestId = useRef<number | null>(null)
  const pendingCreateRequestRef = useRef<ResourceCreateRequest | null>(null)

  useEffect(() => {
    if (!createRequest || handledCreateRequestId.current === createRequest.id) return
    handledCreateRequestId.current = createRequest.id
    pendingCreateRequestRef.current = createRequest
    setEditingSkill(null)
    setCreateTarget(normalizeSkillCreateTarget(createRequest.target))
    setUploadModalOpen(true)
  }, [createRequest])

  // Skill market availability state
  const [skillMarketInfo, setSkillMarketInfo] = useState<SkillMarketAvailability>({
    available: false,
  })

  // Reference conflict dialog state
  const [referenceConflictOpen, setReferenceConflictOpen] = useState(false)
  const [referencedGhosts, setReferencedGhosts] = useState<ReferencedGhost[]>([])
  const [referenceDialogMode, setReferenceDialogMode] = useState<'view' | 'delete_conflict'>(
    'delete_conflict'
  )

  // Check skill market availability on mount
  useEffect(() => {
    const checkMarketAvailability = async () => {
      try {
        const info = await checkSkillMarketAvailable()
        setSkillMarketInfo(info)
      } catch (error) {
        console.error('Failed to check skill market availability:', error)
        setSkillMarketInfo({ available: false })
      }
    }
    checkMarketAvailability()
  }, [])

  useEffect(() => {
    if (!compact) return

    let isMounted = true
    resourceLibraryApi
      .listMyPublished({ resourceType: 'skill', page: 1, limit: 100 })
      .then(response => {
        if (isMounted) {
          setPublishedSkillIds(
            new Set(response.items.filter(item => item.status === 'published').map(item => item.id))
          )
        }
      })
      .catch(() => {
        if (isMounted) setPublishedSkillIds(new Set())
      })

    return () => {
      isMounted = false
    }
  }, [compact])

  // Fetch group details when selectedGroup changes
  useEffect(() => {
    const fetchGroupDetails = async () => {
      if (selectedGroup && scope === 'group') {
        try {
          const groupData = await getGroup(selectedGroup)
          setCurrentGroup(groupData)
        } catch (err) {
          console.error('Failed to fetch group details:', err)
          setCurrentGroup(null)
        }
      } else {
        setCurrentGroup(null)
      }
    }
    fetchGroupDetails()
  }, [selectedGroup, scope])

  const loadSkills = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const libraryParams = {
        scope: scope,
        groupName: selectedGroup || undefined,
      }
      const shouldReuseAllSkills = scope === 'all' && !selectedGroup
      const [allSkillsData, bindingsData] = await Promise.all([
        fetchUnifiedSkillsList({ scope: 'all' }),
        showAutoEnabledSkills ? fetchMyDefaultSkillBindings() : Promise.resolve([]),
      ])
      const librarySkillsData = shouldReuseAllSkills
        ? allSkillsData
        : await fetchUnifiedSkillsList(libraryParams)
      setAutoEnabledBindings(bindingsData)
      setAllAvailableSkills(filterVisibleSkills(allSkillsData))
      setLibrarySkills(filterVisibleSkills(librarySkillsData))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills')
    } finally {
      setLoading(false)
    }
  }, [scope, selectedGroup, showAutoEnabledSkills])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  // Check if current user can delete a skill
  const canDeleteSkill = (skill: UnifiedSkill): boolean => {
    if (!user) return false
    if (isSystemSkill(skill)) return false

    // User can delete their own skills
    if (skill.user_id === user.id) return true

    // In group scope, check if user has delete permission (Owner or Maintainer)
    if (scope === 'group' && currentGroup?.my_role) {
      return canDelete(currentGroup.my_role)
    }

    // System admin can delete any skill
    if (user.role === 'admin') return true

    return false
  }

  const canEditSkill = (skill: UnifiedSkill): boolean => {
    if (!user || isSystemSkill(skill)) return false
    if (skill.user_id === user.id || user.role === 'admin') return true
    return scope === 'group' && !!currentGroup?.my_role && canEditContent(currentGroup.my_role)
  }

  const canEditSkillShareScope = (skill: UnifiedSkill): boolean => {
    if (!user || isSystemSkill(skill)) return false
    if (skill.user_id === user.id || user.role === 'admin') return true
    return scope === 'group' && !!currentGroup?.my_role && canDelete(currentGroup.my_role)
  }

  const getSkillSourceLabel = (skill: UnifiedSkill): string => {
    if (isSystemSkill(skill)) return tSettings('skills.source.system')
    if (skill.namespace && skill.namespace !== 'default') return tSettings('skills.source.group')
    if (user && skill.user_id === user.id) return tSettings('skills.source.personal')
    return tSettings('skills.source.library')
  }

  const isGroupSkill = useCallback(
    (skill: UnifiedSkill) =>
      !isSystemSkill(skill) && Boolean(skill.namespace && skill.namespace !== 'default'),
    []
  )

  const matchesSourceFilter = useCallback(
    (skill: UnifiedSkill): boolean => {
      if (sourceFilter === 'personal') {
        return !isSystemSkill(skill) && skill.namespace === 'default'
      }
      if (sourceFilter === 'group') {
        return isGroupSkill(skill)
      }
      if (sourceFilter === 'system') {
        return isSystemSkill(skill)
      }
      if (sourceFilter === 'mine') {
        return !isSystemSkill(skill)
      }
      return true
    },
    [isGroupSkill, sourceFilter]
  )

  const groupDisplayNames = useMemo(() => buildGroupDisplayNameMap(groups), [groups])

  const getSkillSource = useCallback(
    (skill: UnifiedSkill): ResourceLibrarySortSource => {
      if (isSystemSkill(skill)) return 'system'
      if (isGroupSkill(skill)) return 'group'
      return 'personal'
    },
    [isGroupSkill]
  )

  const sortedLibrarySkills = useMemo(() => {
    const visibleSkills = librarySkills.filter(skill => {
      if (!matchesSourceFilter(skill)) {
        return false
      }

      if (
        !matchesResourceSearch(
          searchQuery,
          skill.name,
          skill.displayName,
          skill.description,
          skill.author,
          skill.tags?.join(' ')
        )
      ) {
        return false
      }

      if (scope === 'personal') {
        return !skill.is_public
      }

      return true
    })

    const groupFilteredSkills = filterResourceLibraryItemsByGroups(
      visibleSkills,
      groupFilter,
      skill => skill.namespace
    )

    return sortResourceLibraryItems(groupFilteredSkills, {
      sortMode,
      groupDisplayNames,
      getSource: getSkillSource,
      getName: skill => skill.name,
      getDisplayName: skill => skill.displayName,
      getNamespace: skill => skill.namespace,
      getCreatedAt: skill => skill.created_at,
      getUpdatedAt: skill => skill.updated_at,
      getStableId: skill => skill.id,
    })
  }, [
    librarySkills,
    matchesSourceFilter,
    searchQuery,
    scope,
    groupFilter,
    sortMode,
    groupDisplayNames,
    getSkillSource,
  ])

  const updateSkillDefaultAvailability = (skillId: number, inMyDefault: boolean) => {
    const updateSkill = (item: UnifiedSkill): UnifiedSkill =>
      item.id === skillId
        ? {
            ...item,
            availability: { ...(item.availability || {}), inMyDefault },
          }
        : item

    setAllAvailableSkills(prev => prev.map(updateSkill))
    setLibrarySkills(prev => prev.map(updateSkill))
  }

  const upsertAutoEnabledBinding = (binding: SkillBinding) => {
    setAutoEnabledBindings(prev => {
      const withoutCurrent = prev.filter(
        item => item.skill_ref.skill_id !== binding.skill_ref.skill_id
      )
      return [...withoutCurrent, binding]
    })
  }

  const removeAutoEnabledBinding = (skillId: number) => {
    setAutoEnabledBindings(prev => prev.filter(item => item.skill_ref.skill_id !== skillId))
  }

  const handleToggleDefaultEnabledSkill = async (skill: UnifiedSkill) => {
    setUpdatingDefaultSkillId(skill.id)
    try {
      if (skill.availability?.inMyDefault) {
        await removeSkillFromMyDefault(skill.id)
        const isOwnedPersonalSkill = user?.id === skill.user_id && skill.namespace === 'default'
        toast.success(
          tSettings(
            isOwnedPersonalSkill
              ? 'skills.availability.removeSuccess'
              : 'skills.availability.removeExternalSuccess'
          )
        )
        updateSkillDefaultAvailability(skill.id, false)
        removeAutoEnabledBinding(skill.id)
      } else {
        const binding = await addSkillToMyDefault(skill.id)
        toast.success(tSettings('skills.availability.addSuccess'))
        updateSkillDefaultAvailability(skill.id, true)
        upsertAutoEnabledBinding(binding)
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : tSettings('skills.availability.updateFailed')
      )
    } finally {
      setUpdatingDefaultSkillId(null)
    }
  }

  const handleDelete = async () => {
    if (!skillToDelete || isSystemSkill(skillToDelete)) return

    try {
      setDeleting(true)
      await deleteSkill(skillToDelete.id)
      toast.success(t('skills.delete_success'))
      loadSkills()
      setDeleteDialogOpen(false)
      setSkillToDelete(null)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)

      // Check if this is a reference conflict error
      const referenceError = parseSkillReferenceError(errorMessage)
      if (referenceError) {
        // Close the simple delete dialog and open the reference conflict dialog
        setDeleteDialogOpen(false)
        setReferencedGhosts(referenceError.referenced_ghosts)
        setReferenceDialogMode('delete_conflict')
        setReferenceConflictOpen(true)
      } else {
        toast.error(errorMessage || t('skills.delete_failed'))
        setDeleteDialogOpen(false)
        setSkillToDelete(null)
      }
    } finally {
      setDeleting(false)
    }
  }

  // Handle removing all references and then deleting the skill
  const handleRemoveAllReferences = async () => {
    if (!skillToDelete) return

    await removeSkillReferences(skillToDelete.id)
    // After removing references, delete the skill
    await deleteSkill(skillToDelete.id)
    loadSkills()
  }

  const handleClearAllReferencesOnly = async () => {
    if (!skillToDelete) return

    await removeSkillReferences(skillToDelete.id)
    loadSkills()
  }

  // Handle removing a single reference
  const handleRemoveSingleReference = async (ghostId: number) => {
    if (!skillToDelete) return

    await removeSingleSkillReference(skillToDelete.id, ghostId)
  }

  const handleViewReferences = async (skill: UnifiedSkill) => {
    try {
      const result = await fetchSkillReferences(skill.id)
      if (result.referenced_ghosts.length === 0) {
        toast.info(t('skills.no_references_found', { skillName: skill.name }))
        return
      }

      setSkillToDelete(skill)
      setReferencedGhosts(result.referenced_ghosts)
      setReferenceDialogMode('view')
      setReferenceConflictOpen(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('skills.references_fetch_failed'))
    }
  }

  // Handle successful deletion after removing references
  const handleDeleteSuccess = () => {
    setSkillToDelete(null)
    setReferencedGhosts([])
    loadSkills()
  }

  const handleDownload = async (skill: UnifiedSkill) => {
    if (isSystemSkill(skill)) {
      toast.error(t('skills.public_no_download'))
      return
    }
    try {
      // For group scope, use the selectedGroup as namespace
      // For personal scope, use the skill's namespace (usually 'default')
      const namespace = scope === 'group' && selectedGroup ? selectedGroup : skill.namespace
      await downloadSkill(skill.id, skill.name, namespace)
      toast.success(t('skills.download_success'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('skills.download_failed'))
    }
  }

  const openDeleteDialog = (skill: UnifiedSkill) => {
    setSkillToDelete(skill)
    setDeleteDialogOpen(true)
  }

  // Handle updating skill from Git repository
  const handleUpdateFromGit = async (skill: UnifiedSkill) => {
    if (!skill.source || skill.source.type !== 'git') return

    setUpdatingFromGitId(skill.id)
    try {
      await updateSkillFromGit(skill.id)
      toast.success(t('skills.success_update_from_git', { skillName: skill.name }))
      loadSkills()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('skills.failed_update_from_git'))
    } finally {
      setUpdatingFromGitId(null)
    }
  }

  // Get git skills for update all
  const getGitSkills = () => {
    return sortedLibrarySkills.filter(
      skill => !isSystemSkill(skill) && skill.source?.type === 'git'
    )
  }

  // Open confirm dialog for update all
  const openUpdateAllConfirm = () => {
    const gitSkills = getGitSkills()
    if (gitSkills.length === 0) {
      toast.info(t('skills.no_git_skills_to_update'))
      return
    }
    setUpdateAllConfirmOpen(true)
  }

  // Handle updating all git-imported skills using batch API
  const handleUpdateAllFromGit = async () => {
    const gitSkills = getGitSkills()

    if (gitSkills.length === 0) {
      toast.info(t('skills.no_git_skills_to_update'))
      return
    }

    // Close confirm dialog and show progress
    setUpdateAllConfirmOpen(false)
    setUpdatingAllFromGit(true)
    setUpdateAllProgress({
      total: gitSkills.length,
      current: 0,
      currentSkillName: t('skills.batch_updating'),
      success: 0,
      failed: 0,
    })

    try {
      // Use batch update API - this groups skills by repository and downloads each repo only once
      const skillIds = gitSkills.map(skill => skill.id)
      const result = await batchUpdateSkillsFromGit(skillIds)

      // Update progress with final results
      setUpdateAllProgress({
        total: gitSkills.length,
        current: gitSkills.length,
        currentSkillName: '',
        success: result.total_success,
        failed: result.total_failed + result.total_skipped,
      })

      // Show result toast
      if (result.total_failed === 0 && result.total_skipped === 0) {
        toast.success(t('skills.update_all_success', { count: result.total_success }))
      } else {
        toast.warning(
          t('skills.update_all_partial', {
            success: result.total_success,
            failed: result.total_failed + result.total_skipped,
          })
        )
      }

      loadSkills()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('skills.failed_update_from_git'))
    } finally {
      setUpdatingAllFromGit(false)
      setUpdateAllProgress(null)
    }
  }

  const defaultEnabledSkills = allAvailableSkills.filter(skill => skill.availability?.inMyDefault)
  const installedSkills = defaultEnabledSkills.filter(
    skill =>
      (!user || skill.user_id !== user.id || skill.namespace !== 'default') &&
      matchesResourceSearch(
        searchQuery,
        skill.name,
        skill.displayName,
        skill.description,
        skill.author,
        skill.tags?.join(' ')
      )
  )
  const installedSkillIds = new Set(installedSkills.map(skill => skill.id))
  const managedSkills = showAutoEnabledSkills
    ? sortResourceLibraryItems(
        Array.from(
          new Map(
            [...sortedLibrarySkills, ...installedSkills].map(skill => [skill.id, skill])
          ).values()
        ),
        {
          sortMode,
          groupDisplayNames,
          getSource: getSkillSource,
          getName: skill => skill.name,
          getDisplayName: skill => skill.displayName,
          getNamespace: skill => skill.namespace,
          getCreatedAt: skill => skill.created_at,
          getUpdatedAt: skill => skill.updated_at,
          getStableId: skill => skill.id,
        }
      )
    : sortedLibrarySkills

  if (loading && !creationOnly) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-text-secondary">{t('skills.loading')}</div>
      </div>
    )
  }

  if (error && !creationOnly) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-red-500">{error}</div>
      </div>
    )
  }

  const handleUploadModalClose = async (saved: boolean, skillId?: number) => {
    const hadPendingCreateRequest = pendingCreateRequestRef.current !== null
    setUploadModalOpen(false)
    if (saved) {
      await loadSkills()
      if (pendingCreateRequestRef.current?.publishAfterCreate && skillId) {
        try {
          const skill = await getSkill(skillId)
          await resourceLibraryApi.createListing({
            resource_type: 'skill',
            source_id: skillId,
            name: skill.metadata.name,
            display_name: skill.spec.displayName || skill.metadata.name,
            description: skill.spec.description || null,
            icon: null,
            tags: skill.spec.tags || [],
            version: skill.spec.version || '1.0.0',
            manifest_options: {},
          })
          toast.success(t('resource-library:messages.publish_success'))
        } catch (publishError) {
          toast.error(
            publishError instanceof Error
              ? publishError.message
              : t('resource-library:messages.publish_failed')
          )
        }
      }
      if (pendingCreateRequestRef.current) onCreated?.(skillId)
    }
    setEditingSkill(null)
    setCreateTarget({ scope: 'personal' })
    pendingCreateRequestRef.current = null
    if (!saved && hadPendingCreateRequest) onCreateRequestClose?.()
  }

  const handleCreateOptionsChange = (target: ResourceCreateTarget, publishAfterCreate: boolean) => {
    setCreateTarget(target)
    if (pendingCreateRequestRef.current) {
      pendingCreateRequestRef.current = {
        ...pendingCreateRequestRef.current,
        target,
        publishAfterCreate,
      }
    }
  }

  const handleOpenUpload = (target: ResourceCreateTarget) => {
    setEditingSkill(null)
    setCreateTarget(normalizeSkillCreateTarget(target))
    setUploadModalOpen(true)
  }

  const handleEditSkill = (skill: UnifiedSkill) => {
    pendingCreateRequestRef.current = null
    setEditingSkill(skill)
    setCreateTarget(
      isGroupSkill(skill) ? { scope: 'group', groupName: skill.namespace } : { scope: 'personal' }
    )
    setUploadModalOpen(true)
  }

  const handleOpenSearch = (target: ResourceCreateTarget) => {
    setCreateTarget(target)
    setSearchModalOpen(true)
  }

  // Check if there are any git-imported skills
  const hasGitSkills = sortedLibrarySkills.some(
    skill => !isSystemSkill(skill) && skill.source?.type === 'git'
  )

  const libraryActions = (
    <>
      {/* Go to Market button - only show if skill market is available and has URL */}
      {skillMarketInfo.available && skillMarketInfo.marketUrl && (
        <Button
          onClick={() => window.open(skillMarketInfo.marketUrl, '_blank', 'noopener,noreferrer')}
          size="sm"
        >
          <ExternalLink className="w-4 h-4 mr-1" />
          {tSettings('skills.go_to_market')}
        </Button>
      )}
      {/* Search Skills button - only show if skill market is available */}
      {!hideCreateActions && skillMarketInfo.available && (
        <ResourceCreateButton
          label={tSettings('skills.search_skills')}
          scope={scope}
          groupName={selectedGroup || undefined}
          sourceFilter={sourceFilter}
          groups={groups}
          onCreate={handleOpenSearch}
          data-testid="search-skill-button"
        />
      )}
      {/* Update All from Git button - only show if there are git-imported skills */}
      {hasGitSkills && (
        <Button
          onClick={openUpdateAllConfirm}
          size="sm"
          variant="outline"
          disabled={updatingAllFromGit}
        >
          <RefreshCw className={`w-4 h-4 mr-1 ${updatingAllFromGit ? 'animate-spin' : ''}`} />
          {t('skills.update_all_from_git')}
        </Button>
      )}
      {!hideCreateActions && (
        <ResourceCreateButton
          label={t('skills.upload_skill')}
          scope={scope}
          groupName={selectedGroup || undefined}
          sourceFilter={sourceFilter}
          groups={groups}
          onCreate={handleOpenUpload}
          data-testid="upload-skill-button"
        />
      )}
    </>
  )

  const libraryFilters =
    sourceControls || sortControls ? (
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        {sourceControls ? (
          <div className="min-w-0" data-testid="skill-library-source-filter">
            {sourceControls}
          </div>
        ) : null}
        {sortControls ? (
          <div
            className="flex shrink-0 justify-end lg:ml-auto"
            data-testid="skill-library-sort-controls"
          >
            {sortControls}
          </div>
        ) : null}
      </div>
    ) : null

  return (
    <div className={creationOnly ? 'contents' : 'space-y-6'}>
      {!creationOnly && (
        <>
          <ResourceManagementLayout
            title={tSettings(
              sourceFilter === 'group'
                ? 'skills.groupLibraryTitle'
                : showAutoEnabledSkills
                  ? 'skills.myLibraryTitle'
                  : 'skills.libraryTitle'
            )}
            description={tSettings(
              sourceFilter === 'group'
                ? 'skills.groupLibraryDescription'
                : showAutoEnabledSkills
                  ? 'skills.myLibraryDescription'
                  : 'skills.libraryDescription'
            )}
            actions={libraryActions}
            filters={libraryFilters}
            hideHeader={compact}
            data-testid="skill-library-section"
          >
            {/* Skills list */}
            {managedSkills.length === 0 ? (
              <div className="text-center py-12 text-text-secondary">
                <Sparkles className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>{t('skills.no_skills')}</p>
                <p className="text-sm mt-2">{t('skills.no_skills_hint')}</p>
              </div>
            ) : (
              <div className={getResourceGridClassName(compact)} data-testid="skill-library-list">
                {managedSkills.map(skill => {
                  if (installedSkillIds.has(skill.id)) {
                    return (
                      <InstalledSkillCard
                        key={skill.id}
                        skill={skill}
                        sourceLabel={getSkillSourceLabel(skill)}
                        sourceVariant={
                          isSystemSkill(skill)
                            ? 'info'
                            : isGroupSkill(skill)
                              ? 'success'
                              : 'secondary'
                        }
                        isUpdating={updatingDefaultSkillId === skill.id}
                        onConfigure={() => setConfiguringSkill(skill)}
                        onDisable={() => handleToggleDefaultEnabledSkill(skill)}
                      />
                    )
                  }

                  const defaultEnabledSwitch = (
                    <Switch
                      checked={Boolean(skill.availability?.inMyDefault)}
                      onCheckedChange={() => handleToggleDefaultEnabledSkill(skill)}
                      disabled={updatingDefaultSkillId === skill.id}
                      aria-label={
                        skill.availability?.inMyDefault
                          ? tSettings('skills.availability.removeFromMyDefault')
                          : tSettings('skills.availability.addToMyDefault')
                      }
                      title={tSettings('skills.availability.inMyDefault')}
                      data-testid={
                        skill.availability?.inMyDefault
                          ? `remove-skill-default-button-${skill.id}`
                          : `add-skill-default-button-${skill.id}`
                      }
                    />
                  )

                  return (
                    <Card
                      key={skill.id}
                      className={cn(
                        getResourceCardClassName(compact),
                        compact && 'group relative gap-3'
                      )}
                      data-testid={`skill-library-item-${skill.id}`}
                    >
                      <div className={getResourceCardBodyClassName(compact)}>
                        {compact ? (
                          <>
                            <div className="flex min-w-0 items-start gap-3">
                              <ResourceCardIcon compact>
                                <Sparkles className="h-5 w-5 text-primary" aria-hidden />
                              </ResourceCardIcon>
                              <div className="min-w-0 flex-1">
                                <h3
                                  className="truncate font-semibold text-text-primary"
                                  title={skill.displayName || skill.name}
                                >
                                  {skill.displayName || skill.name}
                                </h3>
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  <Badge
                                    variant={
                                      isSystemSkill(skill)
                                        ? 'info'
                                        : isGroupSkill(skill)
                                          ? 'success'
                                          : 'secondary'
                                    }
                                  >
                                    {getSkillSourceLabel(skill)}
                                  </Badge>
                                  {skill.version && (
                                    <span className="text-xs text-text-muted">
                                      v{skill.version}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div
                                className="relative z-20 ml-auto flex shrink-0 items-center gap-1"
                                data-testid={`skill-card-top-actions-${skill.id}`}
                              >
                                {(skill.publication_status === 'published' ||
                                  publishedSkillIds.has(skill.id)) && (
                                  <PublishedResourceIndicator
                                    testId={`published-skill-${skill.id}-indicator`}
                                  />
                                )}
                                <span className="flex h-11 w-11 items-center justify-center md:h-9 md:w-9">
                                  <span className="sr-only">
                                    {tSettings('skills.availability.inMyDefault')}
                                  </span>
                                  {defaultEnabledSwitch}
                                </span>
                              </div>
                            </div>
                            {skill.description && (
                              <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
                                {skill.description}
                              </p>
                            )}
                            {(canEditSkill(skill) ||
                              skill.availability?.inMyDefault ||
                              !isSystemSkill(skill)) && (
                              <div
                                className={cn(
                                  'relative z-20 flex flex-shrink-0 items-center gap-2',
                                  getResourceCardActionsClassName(true)
                                )}
                                data-testid={`skill-card-actions-${skill.id}`}
                              >
                                {canEditSkill(skill) && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleEditSkill(skill)}
                                    title={t('resource-library:actions.edit_skill')}
                                    className="h-11 min-w-0 flex-1 gap-2 px-3 text-xs md:h-8"
                                    data-testid={`edit-skill-button-${skill.id}`}
                                  >
                                    <Pencil className="h-4 w-4" />
                                    <span>{t('actions.edit')}</span>
                                  </Button>
                                )}
                                {(skill.availability?.inMyDefault || !isSystemSkill(skill)) && (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="outline"
                                        size="icon"
                                        className="h-11 w-11 shrink-0 md:h-8 md:w-8"
                                        aria-label={t('teams.more_actions')}
                                        data-testid={`skill-card-more-button-${skill.id}`}
                                      >
                                        <MoreHorizontal className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-44">
                                      {canEditSkillShareScope(skill) && (
                                        <DropdownMenuItem
                                          onClick={() => setShareScopeSkill(skill)}
                                          data-testid={`edit-skill-share-scope-button-${skill.id}`}
                                        >
                                          <SlidersHorizontal className="mr-2 h-4 w-4" />
                                          {t('resource-library:publication.edit_share_scope')}
                                        </DropdownMenuItem>
                                      )}
                                      {canEditSkillShareScope(skill) &&
                                        skill.availability?.inMyDefault && (
                                          <DropdownMenuSeparator />
                                        )}
                                      {skill.availability?.inMyDefault && (
                                        <>
                                          <DropdownMenuItem
                                            onClick={() => setConfiguringSkill(skill)}
                                            data-testid={`configure-personal-skill-${skill.id}`}
                                          >
                                            <Settings2 className="mr-2 h-4 w-4" />
                                            {tSettings('skills.autoSettings.configure')}
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                        </>
                                      )}
                                      {canEditSkill(skill) && skill.source?.type === 'git' && (
                                        <DropdownMenuItem
                                          onClick={() => handleUpdateFromGit(skill)}
                                          disabled={updatingFromGitId === skill.id}
                                          data-testid={`update-skill-from-git-button-${skill.id}`}
                                        >
                                          <RefreshCw className="mr-2 h-4 w-4" />
                                          {t('skills.update_from_git')}
                                        </DropdownMenuItem>
                                      )}
                                      <DropdownMenuItem
                                        onClick={() => handleDownload(skill)}
                                        data-testid={`download-skill-button-${skill.id}`}
                                      >
                                        <Download className="mr-2 h-4 w-4" />
                                        {t('actions.download')}
                                      </DropdownMenuItem>
                                      {canDeleteSkill(skill) && (
                                        <DropdownMenuItem
                                          onClick={() => handleViewReferences(skill)}
                                          data-testid={`view-skill-references-button-${skill.id}`}
                                        >
                                          <Link2 className="mr-2 h-4 w-4" />
                                          {t('skills.view_references')}
                                        </DropdownMenuItem>
                                      )}
                                      {canDeleteSkill(skill) && <DropdownMenuSeparator />}
                                      {canDeleteSkill(skill) && (
                                        <DropdownMenuItem
                                          danger
                                          onClick={() => openDeleteDialog(skill)}
                                          data-testid={`delete-skill-button-${skill.id}`}
                                        >
                                          <Trash2 className="mr-2 h-4 w-4" />
                                          {t('actions.delete')}
                                        </DropdownMenuItem>
                                      )}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <ResourceListItem
                            name={skill.name}
                            displayName={skill.displayName || skill.name}
                            description={skill.description}
                            icon={
                              <ResourceCardIcon compact={false}>
                                <Sparkles className="h-5 w-5 text-primary" aria-hidden />
                              </ResourceCardIcon>
                            }
                            tags={[
                              {
                                key: 'source',
                                label: getSkillSourceLabel(skill),
                                variant: isSystemSkill(skill)
                                  ? 'info'
                                  : isGroupSkill(skill)
                                    ? 'success'
                                    : 'default',
                              },
                              ...(isGroupSkill(skill)
                                ? [
                                    {
                                      key: 'namespace',
                                      label: skill.namespace,
                                      variant: 'info' as const,
                                    },
                                  ]
                                : []),
                              ...(skill.version
                                ? [
                                    {
                                      key: 'version',
                                      label: `v${skill.version}`,
                                      variant: 'default' as const,
                                    },
                                  ]
                                : []),
                              ...(skill.source?.type === 'git'
                                ? [
                                    {
                                      key: 'source-git',
                                      label: 'Git',
                                      variant: 'info' as const,
                                    },
                                  ]
                                : []),
                              ...(skill.availability?.inMyDefault
                                ? [
                                    {
                                      key: 'default-enabled',
                                      label: tSettings('skills.availability.inMyDefault'),
                                      variant: 'success' as const,
                                    },
                                  ]
                                : []),
                              ...((skill.tags || []).slice(0, 3).map(tag => ({
                                key: `tag-${tag}`,
                                label: tag,
                                variant: 'info' as const,
                              })) || []),
                              ...(skill.tags && skill.tags.length > 3
                                ? [
                                    {
                                      key: 'tags-more',
                                      label: `+${skill.tags.length - 3}`,
                                      variant: 'info' as const,
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        )}

                        {!compact && (
                          <div
                            className={cn(
                              'flex flex-shrink-0 items-center gap-2',
                              getResourceCardActionsClassName(false)
                            )}
                            data-testid={`skill-card-actions-${skill.id}`}
                          >
                            <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3">
                              <span className="text-xs font-medium text-text-secondary">
                                {tSettings('skills.availability.inMyDefault')}
                              </span>
                              {defaultEnabledSwitch}
                            </div>
                            {!isSystemSkill(skill) && (
                              <>
                                {skill.source?.type === 'git' && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleUpdateFromGit(skill)}
                                    disabled={updatingFromGitId === skill.id}
                                    className="h-8 w-8 text-text-secondary hover:text-text-primary"
                                    title={t('skills.update_from_git')}
                                  >
                                    <RefreshCw
                                      className={`w-4 h-4 ${updatingFromGitId === skill.id ? 'animate-spin' : ''}`}
                                    />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleDownload(skill)}
                                  className="h-8 w-8 text-text-secondary hover:text-text-primary"
                                  title={t('actions.download')}
                                  data-testid={`download-skill-button-${skill.id}`}
                                >
                                  <Download className="w-4 h-4" />
                                </Button>
                                {canDeleteSkill(skill) && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleViewReferences(skill)}
                                    className="h-8 w-8 text-text-secondary hover:text-text-primary"
                                    title={t('skills.view_references')}
                                    data-testid={`view-skill-references-button-${skill.id}`}
                                  >
                                    <Link2 className="w-4 h-4" />
                                  </Button>
                                )}
                                {/* Show delete button if user has permission */}
                                {canDeleteSkill(skill) && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openDeleteDialog(skill)}
                                    className="h-8 w-8 text-red-500 hover:text-red-600"
                                    title={t('actions.delete')}
                                    data-testid={`delete-skill-button-${skill.id}`}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}
          </ResourceManagementLayout>
        </>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('skills.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('skills.delete_confirm_message', { skillName: skillToDelete?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-red-500">
              {deleting ? t('actions.deleting') : t('actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Upload Modal */}
      <SkillUploadModal
        open={uploadModalOpen}
        onClose={handleUploadModalClose}
        skill={editingSkill}
        namespace={editingSkill?.namespace || 'default'}
        createTarget={createTarget}
        writableGroups={groups.filter(
          group =>
            group.my_role === 'Owner' ||
            group.my_role === 'Maintainer' ||
            group.my_role === 'Developer'
        )}
        publishAfterCreate={
          !editingSkill && Boolean(pendingCreateRequestRef.current?.publishAfterCreate)
        }
        onCreateOptionsChange={editingSkill ? undefined : handleCreateOptionsChange}
      />

      <SkillShareScopeDialog
        skill={shareScopeSkill}
        groups={groups}
        open={Boolean(shareScopeSkill)}
        onOpenChange={open => {
          if (!open) setShareScopeSkill(null)
        }}
        onSaved={loadSkills}
      />

      {/* Search Modal */}
      <SkillSearchModal
        open={searchModalOpen}
        onClose={() => {
          setSearchModalOpen(false)
          setCreateTarget({ scope: 'personal' })
        }}
        onSkillsChange={loadSkills}
        namespace={createTarget.scope === 'group' ? createTarget.groupName : 'default'}
      />

      {showAutoEnabledSkills && (
        <AutoEnabledSkillConfigDialog
          open={Boolean(configuringSkill)}
          onOpenChange={open => {
            if (!open) setConfiguringSkill(null)
          }}
          skill={configuringSkill}
          binding={autoEnabledBindings.find(
            binding => binding.skill_ref.skill_id === configuringSkill?.id
          )}
          currentUserId={user?.id ?? null}
          onBindingChange={upsertAutoEnabledBinding}
        />
      )}

      {/* Reference Conflict Dialog */}
      {skillToDelete && (
        <SkillReferenceConflictDialog
          open={referenceConflictOpen}
          onOpenChange={setReferenceConflictOpen}
          skillName={skillToDelete.name}
          skillId={skillToDelete.id}
          referencedGhosts={referencedGhosts}
          mode={referenceDialogMode}
          onRemoveAllReferences={
            referenceDialogMode === 'delete_conflict'
              ? handleRemoveAllReferences
              : handleClearAllReferencesOnly
          }
          onRemoveSingleReference={handleRemoveSingleReference}
          onAfterUpdate={handleDeleteSuccess}
        />
      )}

      {/* Update All Confirmation Dialog */}
      <AlertDialog open={updateAllConfirmOpen} onOpenChange={setUpdateAllConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('skills.update_all_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('skills.update_all_confirm_message', { count: getGitSkills().length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUpdateAllFromGit}
              className="bg-primary text-white hover:bg-primary/90"
            >
              {t('actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Update All Progress Dialog */}
      <Dialog open={updatingAllFromGit} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-md" hideCloseButton>
          <DialogHeader>
            <DialogTitle>{t('skills.update_all_progress_title')}</DialogTitle>
            <DialogDescription>{t('skills.update_all_progress_description')}</DialogDescription>
          </DialogHeader>
          {updateAllProgress && (
            <div className="space-y-4 py-4">
              {/* Progress bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-text-secondary">
                  <span>
                    {updateAllProgress.current} / {updateAllProgress.total}
                  </span>
                  <span>
                    {Math.round((updateAllProgress.current / updateAllProgress.total) * 100)}%
                  </span>
                </div>
                <Progress
                  value={(updateAllProgress.current / updateAllProgress.total) * 100}
                  className="h-2"
                />
              </div>

              {/* Current skill name */}
              {updateAllProgress.currentSkillName && (
                <div className="flex items-center gap-2 text-sm">
                  <RefreshCw className="w-4 h-4 animate-spin text-primary" />
                  <span className="text-text-secondary truncate">
                    {t('skills.updating_skill', { name: updateAllProgress.currentSkillName })}
                  </span>
                </div>
              )}

              {/* Success/Failed counts */}
              <div className="flex gap-4 text-sm">
                <span className="text-green-600">
                  ✓ {t('skills.update_success_count', { count: updateAllProgress.success })}
                </span>
                {updateAllProgress.failed > 0 && (
                  <span className="text-red-500">
                    ✗ {t('skills.update_failed_count', { count: updateAllProgress.failed })}
                  </span>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
