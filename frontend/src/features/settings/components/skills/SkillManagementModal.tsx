// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { PencilIcon, TrashIcon, DownloadIcon, PackageIcon } from 'lucide-react'
import LoadingState from '@/features/common/LoadingState'
import { fetchUnifiedSkillsList, UnifiedSkill, deleteSkill, downloadSkill } from '@/apis/skills'
import SkillUploadModal from './SkillUploadModal'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

interface SkillManagementModalProps {
  open: boolean
  onClose: () => void
  onSkillsChange?: () => void
  scope?: 'personal' | 'group' | 'all'
  groupName?: string | null
}

export default function SkillManagementModal({
  open,
  onClose,
  onSkillsChange,
  scope = 'personal',
  groupName,
}: SkillManagementModalProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<UnifiedSkill | null>(null)
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false)
  const [skillToDelete, setSkillToDelete] = useState<UnifiedSkill | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Determine the namespace for uploading skills
  const uploadNamespace = scope === 'group' && groupName ? groupName : 'default'

  const loadSkills = useCallback(async () => {
    setIsLoading(true)
    try {
      const skillsData = await fetchUnifiedSkillsList({
        scope: scope,
        groupName: groupName || undefined,
      })
      // Filter out public skills for management (only show user's own skills)
      setSkills(skillsData.filter(s => !s.is_public))
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:skills.failed_load'),
        description: error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [toast, scope, groupName, t])

  useEffect(() => {
    if (open) {
      loadSkills()
    }
  }, [open, loadSkills])

  const handleCreateSkill = () => {
    setEditingSkill(null)
    setUploadModalOpen(true)
  }

  const handleEditSkill = (skill: UnifiedSkill) => {
    setEditingSkill(skill)
    setUploadModalOpen(true)
  }

  const handleDeleteSkill = (skill: UnifiedSkill) => {
    setSkillToDelete(skill)
    setDeleteConfirmVisible(true)
  }

  const handleConfirmDelete = async () => {
    if (!skillToDelete) return

    setIsDeleting(true)
    try {
      await deleteSkill(skillToDelete.id)
      toast({
        title: t('common:common.success'),
        description: t('common:skills.success_delete', { skillName: skillToDelete.name }),
      })
      await loadSkills()
      onSkillsChange?.()
      setDeleteConfirmVisible(false)
      setSkillToDelete(null)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:skills.failed_delete'),
        description: error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleDownloadSkill = async (skill: UnifiedSkill) => {
    try {
      await downloadSkill(skill.id, skill.name)
      toast({
        title: t('common:common.success'),
        description: t('common:skills.success_download', { skillName: skill.name }),
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:skills.failed_download'),
        description: error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
    }
  }

  const handleModalClose = (saved: boolean) => {
    setUploadModalOpen(false)
    setEditingSkill(null)
    if (saved) {
      loadSkills()
      onSkillsChange?.()
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[800px] max-h-[80vh] flex flex-col bg-surface">
          <DialogHeader>
            <DialogTitle>{t('common:skills.manage_skills')}</DialogTitle>
            <DialogDescription>{t('common:skills.manage_skills_description')}</DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-4">
            {isLoading ? (
              <LoadingState message={t('common:skills.loading')} />
            ) : (
              <div className="space-y-4">
                {/* Add Button */}
                <div className="flex justify-end">
                  <UnifiedAddButton onClick={handleCreateSkill}>
                    {t('common:skills.upload_skill')}
                  </UnifiedAddButton>
                </div>

                {/* Skills List */}
                {skills.length === 0 ? (
                  <Card className="p-8 text-center">
                    <PackageIcon className="w-12 h-12 mx-auto text-text-muted mb-3" />
                    <h3 className="text-base font-medium text-text-primary mb-2">
                      {t('common:skills.no_skills')}
                    </h3>
                    <p className="text-sm text-text-muted mb-4">
                      {t('common:skills.no_skills_description')}
                    </p>
                    <Button onClick={handleCreateSkill}>
                      {t('common:skills.upload_first_skill')}
                    </Button>
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {skills.map(skill => (
                      <Card
                        key={skill.id || skill.name}
                        className="p-4 hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-start justify-between">
                          {/* Skill Info */}
                          <div className="flex items-start gap-3 min-w-0 flex-1">
                            <PackageIcon className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                              <h3 className="text-base font-medium text-text-primary truncate">
                                {skill.name}
                              </h3>
                              <p className="text-sm text-text-secondary mt-1 line-clamp-2">
                                {skill.description}
                              </p>

                              {/* Tags and Metadata */}
                              <div className="flex flex-wrap gap-1.5 mt-2">
                                {skill.version && (
                                  <Tag variant="default">
                                    {t('common:skills.version', { version: skill.version })}
                                  </Tag>
                                )}
                                {skill.author && (
                                  <Tag variant="default">
                                    {t('common:skills.author', { author: skill.author })}
                                  </Tag>
                                )}
                                {skill.tags?.map(tag => (
                                  <Tag key={tag} variant="info">
                                    {tag}
                                  </Tag>
                                ))}
                              </div>

                              {/* Bind Shells */}
                              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                                <span className="text-xs text-text-muted">
                                  {t('skills.bind_shells')}:
                                </span>
                                {skill.bindShells && skill.bindShells.length > 0 ? (
                                  skill.bindShells.map(shell => (
                                    <Tag key={shell} variant="success">
                                      {shell}
                                    </Tag>
                                  ))
                                ) : (
                                  <span className="text-xs text-text-muted italic">
                                    {t('skills.no_bind_shells')}
                                  </span>
                                )}
                              </div>

                              {/* Namespace info for group skills */}
                              {scope === 'group' &&
                                skill.namespace &&
                                skill.namespace !== 'default' && (
                                  <div className="flex items-center gap-1.5 mt-2">
                                    <span className="text-xs text-text-muted">
                                      {t('common:skills.namespace')}: {skill.namespace}
                                    </span>
                                  </div>
                                )}
                            </div>
                          </div>

                          {/* Action Buttons */}
                          <div className="flex gap-1 flex-shrink-0 ml-4">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleDownloadSkill(skill)}
                              title={t('common:skills.download_skill')}
                            >
                              <DownloadIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleEditSkill(skill)}
                              title={t('common:skills.update_skill')}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-error hover:text-error hover:bg-error/10"
                              onClick={() => handleDeleteSkill(skill)}
                              title={t('common:skills.delete_skill')}
                            >
                              <TrashIcon className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common:actions.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload/Edit Modal */}
      {uploadModalOpen && (
        <SkillUploadModal
          open={uploadModalOpen}
          onClose={handleModalClose}
          skill={editingSkill}
          namespace={uploadNamespace}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteConfirmVisible}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmVisible(false)}
      >
        <DialogContent className="bg-surface">
          <DialogHeader>
            <DialogTitle>{t('common:skills.delete_confirm_title')}</DialogTitle>
            <DialogDescription>
              {t('common:skills.delete_confirm_message', {
                skillName: skillToDelete?.name,
              })}
              {skillToDelete && (
                <div className="mt-3 p-3 bg-muted rounded-md text-sm">
                  <strong>{t('common:skills.delete_note')}</strong>
                </div>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmVisible(false)}
              disabled={isDeleting}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeleting}>
              {isDeleting ? (
                <div className="flex items-center">
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  {t('common:actions.deleting')}
                </div>
              ) : (
                t('common:actions.delete')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
