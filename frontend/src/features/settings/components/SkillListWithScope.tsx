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
} from '@/apis/skills'
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
import { Download, Trash2, Sparkles, Globe, Plus } from 'lucide-react'
import { toast } from 'sonner'
import SkillUploadModal from './skills/SkillUploadModal'
import { SkillReferenceConflictDialog } from './skills/SkillReferenceConflictDialog'

interface SkillListWithScopeProps {
  scope: 'personal' | 'group' | 'all'
  selectedGroup?: string | null
  onGroupChange?: (groupName: string | null) => void
}

export function SkillListWithScope({ scope, selectedGroup }: SkillListWithScopeProps) {
  const { t } = useTranslation('common')
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [skillToDelete, setSkillToDelete] = useState<UnifiedSkill | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploadModalOpen, setUploadModalOpen] = useState(false)

  // Reference conflict dialog state
  const [referenceConflictOpen, setReferenceConflictOpen] = useState(false)
  const [referencedGhosts, setReferencedGhosts] = useState<ReferencedGhost[]>([])

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
      await downloadSkill(skill.id, skill.name)
      toast.success(t('skills.download_success'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('skills.download_failed'))
    }
  }

  const openDeleteDialog = (skill: UnifiedSkill) => {
    setSkillToDelete(skill)
    setDeleteDialogOpen(true)
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

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">{t('skills.title')}</h2>
          <p className="text-sm text-text-secondary">{t('skills.description')}</p>
        </div>
        <Button onClick={() => setUploadModalOpen(true)} size="sm">
          <Plus className="w-4 h-4 mr-1" />
          {t('skills.upload_skill')}
        </Button>
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
                  <h3 className="font-medium text-text-primary">{skill.name}</h3>
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

              {/* Actions */}
              <div className="flex items-center gap-2 pt-2 border-t border-border">
                {!skill.is_public && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDownload(skill)}
                      className="text-text-secondary hover:text-text-primary"
                    >
                      <Download className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openDeleteDialog(skill)}
                      className="text-red-500 hover:text-red-600"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
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
    </div>
  )
}
