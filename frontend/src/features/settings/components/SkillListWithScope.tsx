// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  fetchUnifiedSkillsList,
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
import { canDelete } from '@/types/base-role'
import { filterVisibleSkills } from '@/utils/skillVisibility'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ResourceListItem } from '@/components/common/ResourceListItem'
import { Switch } from '@/components/ui/switch'
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import {
  Download,
  Trash2,
  Sparkles,
  Globe,
  RefreshCw,
  ExternalLink,
  Link2,
  UploadCloud,
} from 'lucide-react'
import { toast } from 'sonner'
import SkillUploadModal from './skills/SkillUploadModal'
import SkillSearchModal from './skills/SkillSearchModal'
import { SkillReferenceConflictDialog } from './skills/SkillReferenceConflictDialog'
import { AutoEnabledSkillsSection } from './skills/AutoEnabledSkillsSection'
import { AutoEnabledSkillSettingsView } from './skills/AutoEnabledSkillSettingsView'
import { useUser } from '@/features/common/UserContext'
import type {
  ManagedResourceSourceFilter,
  ResourceLibraryPublishSource,
} from '@/features/resource-library/types'
import {
  hasResourceCreateTargets,
  ResourceCreateButton,
  type ResourceCreateTarget,
} from '@/features/resource-library/components/ResourceCreateButton'
import { ResourceManagementLayout } from './resource-management/ResourceManagementLayout'

interface SkillListWithScopeProps {
  scope: 'personal' | 'group' | 'all'
  selectedGroup?: string | null
  onGroupChange?: (groupName: string | null) => void
  onPublishResource?: (source: ResourceLibraryPublishSource) => void
  sourceControls?: ReactNode
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
}

export function SkillListWithScope({
  scope,
  selectedGroup,
  onPublishResource,
  sourceControls,
  sourceFilter = 'all',
  groups = [],
}: SkillListWithScopeProps) {
  const { t } = useTranslation('common')
  const { t: tSettingsBase } = useTranslation('settings')
  const tSettings = useCallback(
    (key: string, options?: Record<string, unknown>) => tSettingsBase(key, options),
    [tSettingsBase]
  )
  const { user } = useUser()
  const [librarySkills, setLibrarySkills] = useState<UnifiedSkill[]>([])
  const [allAvailableSkills, setAllAvailableSkills] = useState<UnifiedSkill[]>([])
  const [autoEnabledBindings, setAutoEnabledBindings] = useState<SkillBinding[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [skillToDelete, setSkillToDelete] = useState<UnifiedSkill | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [searchModalOpen, setSearchModalOpen] = useState(false)
  const [addDefaultDialogOpen, setAddDefaultDialogOpen] = useState(false)
  const [autoEnabledSettingsOpen, setAutoEnabledSettingsOpen] = useState(false)
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
        fetchMyDefaultSkillBindings(),
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
  }, [scope, selectedGroup])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  // Check if current user can delete a skill
  const canDeleteSkill = (skill: UnifiedSkill): boolean => {
    if (!user) return false

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

  const canPublishSkill = (skill: UnifiedSkill): boolean => {
    if (!onPublishResource || skill.is_public) return false
    if (scope === 'personal') return true
    return canDeleteSkill(skill)
  }

  const handlePublishSkill = (skill: UnifiedSkill) => {
    onPublishResource?.({
      resourceType: 'skill',
      sourceId: skill.id,
      name: skill.name,
      displayName: skill.displayName || skill.name,
      description: skill.description,
      tags: skill.tags || [],
      namespace: skill.namespace,
    })
  }

  const getSkillSourceLabel = (skill: UnifiedSkill): string => {
    if (skill.is_public) return tSettings('skills.source.system')
    if (skill.namespace && skill.namespace !== 'default') return tSettings('skills.source.group')
    if (user && skill.user_id === user.id) return tSettings('skills.source.personal')
    return tSettings('skills.source.library')
  }

  const isGroupSkill = (skill: UnifiedSkill) =>
    !skill.is_public && Boolean(skill.namespace && skill.namespace !== 'default')

  const matchesSourceFilter = (skill: UnifiedSkill): boolean => {
    if (sourceFilter === 'personal') {
      return !skill.is_public && skill.namespace === 'default'
    }
    if (sourceFilter === 'group') {
      return isGroupSkill(skill)
    }
    if (sourceFilter === 'system') {
      return skill.is_public
    }
    return true
  }

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
        toast.success(tSettings('skills.availability.removeSuccess'))
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
    if (!skillToDelete || skillToDelete.is_public) return

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
    if (skill.is_public) {
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
    return filteredSkills.filter(skill => !skill.is_public && skill.source?.type === 'git')
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

  // Filter skills based on scope
  const filteredSkills = librarySkills.filter(skill => {
    if (!matchesSourceFilter(skill)) {
      return false
    }

    if (scope === 'personal') {
      return !skill.is_public
    }
    // For 'all' scope, show all skills
    return true
  })
  const defaultEnabledSkills = allAvailableSkills.filter(skill => skill.availability?.inMyDefault)
  const defaultEnabledCandidates = allAvailableSkills.filter(
    skill => !skill.availability?.inMyDefault
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-text-secondary">{t('skills.loading')}</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-red-500">{error}</div>
      </div>
    )
  }

  const handleUploadModalClose = (saved: boolean) => {
    setUploadModalOpen(false)
    setCreateTarget({ scope: 'personal' })
    if (saved) {
      loadSkills()
    }
  }

  const handleOpenUpload = (target: ResourceCreateTarget) => {
    setCreateTarget(target)
    setUploadModalOpen(true)
  }

  const handleOpenSearch = (target: ResourceCreateTarget) => {
    setCreateTarget(target)
    setSearchModalOpen(true)
  }

  // Check if there are any git-imported skills
  const hasGitSkills = filteredSkills.some(
    skill => !skill.is_public && skill.source?.type === 'git'
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
      {skillMarketInfo.available && (
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
      <ResourceCreateButton
        label={t('skills.upload_skill')}
        scope={scope}
        groupName={selectedGroup || undefined}
        sourceFilter={sourceFilter}
        groups={groups}
        onCreate={handleOpenUpload}
        data-testid="upload-skill-button"
      />
    </>
  )

  if (autoEnabledSettingsOpen) {
    return (
      <AutoEnabledSkillSettingsView
        skills={defaultEnabledSkills}
        bindings={autoEnabledBindings}
        currentUserId={user?.id ?? null}
        onBack={() => setAutoEnabledSettingsOpen(false)}
        onBindingChange={upsertAutoEnabledBinding}
        getSkillSourceLabel={getSkillSourceLabel}
        isGroupSkill={isGroupSkill}
      />
    )
  }

  return (
    <div className="space-y-6">
      <AutoEnabledSkillsSection
        skills={defaultEnabledSkills}
        getSkillSourceLabel={getSkillSourceLabel}
        isGroupSkill={isGroupSkill}
        onAdd={() => setAddDefaultDialogOpen(true)}
        onOpenSettings={() => setAutoEnabledSettingsOpen(true)}
        tSettings={tSettings}
      />

      <ResourceManagementLayout
        title={tSettings('skills.libraryTitle')}
        description={tSettings('skills.libraryDescription')}
        actions={libraryActions}
        filters={
          sourceControls ? (
            <div data-testid="skill-library-source-filter">{sourceControls}</div>
          ) : null
        }
        data-testid="skill-library-section"
      >
        {/* Skills list */}
        {filteredSkills.length === 0 ? (
          <div className="text-center py-12 text-text-secondary">
            <Sparkles className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>{t('skills.no_skills')}</p>
            <p className="text-sm mt-2">{t('skills.no_skills_hint')}</p>
            {hasResourceCreateTargets({
              scope,
              groupName: selectedGroup || undefined,
              sourceFilter,
              groups,
            }) && (
              <div className="mt-4 flex justify-center">
                <ResourceCreateButton
                  label={t('skills.upload_first_skill')}
                  scope={scope}
                  groupName={selectedGroup || undefined}
                  sourceFilter={sourceFilter}
                  groups={groups}
                  onCreate={handleOpenUpload}
                  data-testid="upload-first-skill-button"
                />
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3" data-testid="skill-library-list">
            {filteredSkills.map(skill => (
              <Card
                key={skill.id}
                className="overflow-hidden bg-base p-3 transition-colors hover:bg-hover sm:p-4"
                data-testid={`skill-library-item-${skill.id}`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <ResourceListItem
                    name={skill.name}
                    displayName={skill.displayName || skill.name}
                    description={skill.description}
                    icon={<Sparkles className="h-5 w-5 text-primary" aria-hidden />}
                    tags={[
                      {
                        key: 'source',
                        label: getSkillSourceLabel(skill),
                        variant: skill.is_public
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

                  <div className="flex flex-shrink-0 items-center gap-2 self-end sm:ml-3 sm:self-auto">
                    <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3">
                      <span className="text-xs font-medium text-text-secondary">
                        {tSettings('skills.availability.inMyDefault')}
                      </span>
                      <Switch
                        checked={Boolean(skill.availability?.inMyDefault)}
                        onCheckedChange={() => handleToggleDefaultEnabledSkill(skill)}
                        disabled={updatingDefaultSkillId === skill.id}
                        aria-label={
                          skill.availability?.inMyDefault
                            ? tSettings('skills.availability.removeFromMyDefault')
                            : tSettings('skills.availability.addToMyDefault')
                        }
                        data-testid={
                          skill.availability?.inMyDefault
                            ? `remove-skill-default-button-${skill.id}`
                            : `add-skill-default-button-${skill.id}`
                        }
                      />
                    </div>
                    {!skill.is_public && (
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
                          title={t('skills.download')}
                          data-testid={`download-skill-button-${skill.id}`}
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        {canPublishSkill(skill) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handlePublishSkill(skill)}
                            className="h-8 w-8 text-text-secondary hover:text-text-primary"
                            title={t('resource-library:actions.publish_to_library')}
                            aria-label={`${t('resource-library:actions.publish_to_library')} ${
                              skill.displayName || skill.name
                            }`}
                            data-testid={`publish-skill-${skill.id}-button`}
                          >
                            <UploadCloud className="w-4 h-4" />
                          </Button>
                        )}
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
                            title={t('skills.delete')}
                            data-testid={`delete-skill-button-${skill.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </ResourceManagementLayout>

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
        namespace={createTarget.scope === 'group' ? createTarget.groupName : 'default'}
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

      <Dialog open={addDefaultDialogOpen} onOpenChange={setAddDefaultDialogOpen}>
        <DialogContent className="sm:max-w-[720px]">
          <DialogHeader>
            <DialogTitle>{tSettings('skills.defaultEnabled.addDialogTitle')}</DialogTitle>
            <DialogDescription>
              {tSettings('skills.defaultEnabled.addDialogDescription')}
            </DialogDescription>
          </DialogHeader>

          {defaultEnabledCandidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
              {tSettings('skills.defaultEnabled.noAvailableToAdd')}
            </div>
          ) : (
            <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {defaultEnabledCandidates.map(skill => (
                <div
                  key={skill.id}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-medium text-text-primary">
                        {skill.displayName || skill.name}
                      </h3>
                      <Badge variant="secondary" className="text-xs">
                        {skill.is_public && <Globe className="w-3 h-3 mr-1" />}
                        {getSkillSourceLabel(skill)}
                      </Badge>
                      {isGroupSkill(skill) && (
                        <Badge variant="info" className="text-xs">
                          {skill.namespace}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-text-secondary">
                      {skill.description}
                    </p>
                    {skill.namespace !== 'default' && (
                      <p className="mt-2 text-xs text-text-muted">
                        {tSettings('skills.availability.groupScopeHint')}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    className="h-11 min-w-[44px] flex-shrink-0 self-start sm:h-9"
                    onClick={() => handleToggleDefaultEnabledSkill(skill)}
                    disabled={updatingDefaultSkillId === skill.id}
                    data-testid={`add-default-enabled-skill-button-${skill.id}`}
                  >
                    {tSettings('skills.availability.addToMyDefault')}
                  </Button>
                </div>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddDefaultDialogOpen(false)}
              data-testid="close-add-auto-enabled-skill-dialog-button"
            >
              {t('actions.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
