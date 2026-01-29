// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  fetchUnifiedSkillsList,
  UnifiedSkill,
  deleteSkill,
  downloadSkill,
  removeSkillReferences,
  removeSingleSkillReference,
  parseSkillReferenceError,
  ReferencedGhost,
  updateSkillFromGit,
  batchUpdateSkillsFromGit,
} from '@/apis/skills'
import { getGroup } from '@/apis/groups'
import { Group } from '@/types/group'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { Download, Trash2, Sparkles, Globe, Plus, RefreshCw, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import SkillUploadModal from './skills/SkillUploadModal'
import { SkillReferenceConflictDialog } from './skills/SkillReferenceConflictDialog'
import { useUser } from '@/features/common/UserContext'

interface SkillListWithScopeProps {
  scope: 'personal' | 'group' | 'all'
  selectedGroup?: string | null
  onGroupChange?: (groupName: string | null) => void
}

export function SkillListWithScope({ scope, selectedGroup }: SkillListWithScopeProps) {
  const { t } = useTranslation('common')
  const { user } = useUser()
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [skillToDelete, setSkillToDelete] = useState<UnifiedSkill | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [currentGroup, setCurrentGroup] = useState<Group | null>(null)
  const [updatingFromGitId, setUpdatingFromGitId] = useState<number | null>(null)
  const [updatingAllFromGit, setUpdatingAllFromGit] = useState(false)
  const [updateAllConfirmOpen, setUpdateAllConfirmOpen] = useState(false)
  const [updateAllProgress, setUpdateAllProgress] = useState<{
    total: number
    current: number
    currentSkillName: string
    success: number
    failed: number
  } | null>(null)

  // Reference conflict dialog state
  const [referenceConflictOpen, setReferenceConflictOpen] = useState(false)
  const [referencedGhosts, setReferencedGhosts] = useState<ReferencedGhost[]>([])

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
      const data = await fetchUnifiedSkillsList({
        scope: scope,
        groupName: selectedGroup || undefined,
      })
      setSkills(data)
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

    // In group scope, check if user is group admin (Owner or Maintainer)
    if (scope === 'group' && currentGroup?.my_role) {
      return currentGroup.my_role === 'Owner' || currentGroup.my_role === 'Maintainer'
    }

    // System admin can delete any skill
    if (user.role === 'admin') return true

    return false
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

  // Handle removing a single reference
  const handleRemoveSingleReference = async (ghostId: number) => {
    if (!skillToDelete) return

    await removeSingleSkillReference(skillToDelete.id, ghostId)
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
  const filteredSkills = skills.filter(skill => {
    if (scope === 'personal') {
      return !skill.is_public
    }
    // For 'all' scope, show all skills
    return true
  })

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
    if (saved) {
      loadSkills()
    }
  }

  // Check if there are any git-imported skills
  const hasGitSkills = filteredSkills.some(
    skill => !skill.is_public && skill.source?.type === 'git'
  )

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">{t('skills.title')}</h2>
          <p className="text-sm text-text-secondary">{t('skills.description')}</p>
        </div>
        <div className="flex items-center gap-2">
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
          <Button onClick={() => setUploadModalOpen(true)} size="sm">
            <Plus className="w-4 h-4 mr-1" />
            {t('skills.upload_skill')}
          </Button>
        </div>
      </div>

      {/* Skills list */}
      {filteredSkills.length === 0 ? (
        <div className="text-center py-12 text-text-secondary">
          <Sparkles className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>{t('skills.no_skills')}</p>
          <p className="text-sm mt-2">{t('skills.no_skills_hint')}</p>
          <Button onClick={() => setUploadModalOpen(true)} className="mt-4">
            <Plus className="w-4 h-4 mr-1" />
            {t('skills.upload_first_skill')}
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredSkills.map(skill => (
            <div
              key={`${skill.name}-${skill.is_public}`}
              className="bg-surface border border-border rounded-lg p-4 hover:border-primary/50 transition-colors"
            >
              {/* Skill header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-text-primary">
                    {skill.displayName || skill.name}
                  </h3>
                  {skill.is_public && (
                    <Badge variant="secondary" className="text-xs">
                      <Globe className="w-3 h-3 mr-1" />
                      {t('skills.system_skill')}
                    </Badge>
                  )}
                </div>
                {skill.version && <span className="text-xs text-text-muted">v{skill.version}</span>}
              </div>

              {/* Description */}
              <p className="text-sm text-text-secondary line-clamp-2 mb-3">{skill.description}</p>

              {/* Tags */}
              {skill.tags && skill.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {skill.tags.slice(0, 3).map(tag => (
                    <Badge key={tag} variant="info" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                  {skill.tags.length > 3 && (
                    <Badge variant="info" className="text-xs">
                      +{skill.tags.length - 3}
                    </Badge>
                  )}
                </div>
              )}

              {/* Author */}
              {skill.author && (
                <p className="text-xs text-text-muted mb-3">
                  {t('skills.author')}: {skill.author}
                </p>
              )}

              {/* Git source info */}
              {skill.source?.type === 'git' && skill.source.repo_url && (
                <div className="flex items-center gap-1.5 mb-3">
                  <GitBranch className="w-3 h-3 text-text-muted" />
                  <span className="text-xs text-text-muted truncate max-w-[200px]">
                    {skill.source.repo_url}
                  </span>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 pt-2 border-t border-border">
                {!skill.is_public && (
                  <>
                    {/* Update from Git button - only show for git-imported skills */}
                    {skill.source?.type === 'git' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUpdateFromGit(skill)}
                        disabled={updatingFromGitId === skill.id}
                        className="text-text-secondary hover:text-text-primary"
                        title={t('skills.update_from_git')}
                      >
                        <RefreshCw
                          className={`w-4 h-4 ${updatingFromGitId === skill.id ? 'animate-spin' : ''}`}
                        />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDownload(skill)}
                      className="text-text-secondary hover:text-text-primary"
                    >
                      <Download className="w-4 h-4" />
                    </Button>
                    {/* Show delete button if user has permission */}
                    {canDeleteSkill(skill) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDeleteDialog(skill)}
                        className="text-red-500 hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </>
                )}
                {skill.is_public && (
                  <span className="text-xs text-text-muted italic">
                    {t('skills.public_readonly')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
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
        namespace={scope === 'group' && selectedGroup ? selectedGroup : 'default'}
      />

      {/* Reference Conflict Dialog */}
      {skillToDelete && (
        <SkillReferenceConflictDialog
          open={referenceConflictOpen}
          onOpenChange={setReferenceConflictOpen}
          skillName={skillToDelete.name}
          skillId={skillToDelete.id}
          referencedGhosts={referencedGhosts}
          onRemoveAllReferences={handleRemoveAllReferences}
          onRemoveSingleReference={handleRemoveSingleReference}
          onDeleteSuccess={handleDeleteSuccess}
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
