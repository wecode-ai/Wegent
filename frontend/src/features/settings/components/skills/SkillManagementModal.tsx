// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useCallback, useEffect, useState } from 'react';
import { PencilIcon, TrashIcon, DownloadIcon, PackageIcon } from 'lucide-react';
import LoadingState from '@/features/common/LoadingState';
import { Skill } from '@/types/api';
import { fetchSkillsList, deleteSkill, downloadSkill, formatFileSize } from '@/apis/skills';
import SkillUploadModal from './SkillUploadModal';
import UnifiedAddButton from '@/components/common/UnifiedAddButton';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tag } from '@/components/ui/tag';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/hooks/useTranslation';

interface SkillManagementModalProps {
  open: boolean;
  onClose: () => void;
  onSkillsChange?: () => void;
}

export default function SkillManagementModal({
  open,
  onClose,
  onSkillsChange,
}: SkillManagementModalProps) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const loadSkills = useCallback(async () => {
    setIsLoading(true);
    try {
      const skillsData = await fetchSkillsList();
      setSkills(skillsData);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('skills.failed_load'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) {
      loadSkills();
    }
  }, [open, loadSkills]);

  const handleCreateSkill = () => {
    setEditingSkill(null);
    setUploadModalOpen(true);
  };

  const handleEditSkill = (skill: Skill) => {
    setEditingSkill(skill);
    setUploadModalOpen(true);
  };

  const handleDeleteSkill = (skill: Skill) => {
    setSkillToDelete(skill);
    setDeleteConfirmVisible(true);
  };

  const handleConfirmDelete = async () => {
    if (!skillToDelete) return;

    setIsDeleting(true);
    try {
      const skillId = parseInt(skillToDelete.metadata.labels?.id || '0');
      await deleteSkill(skillId);
      toast({
        title: t('common.success'),
        description: t('skills.success_delete', { skillName: skillToDelete.metadata.name }),
      });
      await loadSkills();
      onSkillsChange?.();
      setDeleteConfirmVisible(false);
      setSkillToDelete(null);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('skills.failed_delete'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDownloadSkill = async (skill: Skill) => {
    try {
      const skillId = parseInt(skill.metadata.labels?.id || '0');
      await downloadSkill(skillId, skill.metadata.name);
      toast({
        title: t('common.success'),
        description: t('skills.success_download', { skillName: skill.metadata.name }),
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('skills.failed_download'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      });
    }
  };

  const handleModalClose = (saved: boolean) => {
    setUploadModalOpen(false);
    setEditingSkill(null);
    if (saved) {
      loadSkills();
      onSkillsChange?.();
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[800px] max-h-[80vh] flex flex-col bg-surface">
          <DialogHeader>
            <DialogTitle>{t('skills.manage_skills')}</DialogTitle>
            <DialogDescription>{t('skills.manage_skills_description')}</DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto py-4">
            {isLoading ? (
              <LoadingState message={t('skills.loading')} />
            ) : (
              <div className="space-y-4">
                {/* Add Button */}
                <div className="flex justify-end">
                  <UnifiedAddButton onClick={handleCreateSkill}>
                    {t('skills.upload_skill')}
                  </UnifiedAddButton>
                </div>

                {/* Skills List */}
                {skills.length === 0 ? (
                  <Card className="p-8 text-center">
                    <PackageIcon className="w-12 h-12 mx-auto text-text-muted mb-3" />
                    <h3 className="text-base font-medium text-text-primary mb-2">
                      {t('skills.no_skills')}
                    </h3>
                    <p className="text-sm text-text-muted mb-4">
                      {t('skills.no_skills_description')}
                    </p>
                    <Button onClick={handleCreateSkill}>{t('skills.upload_first_skill')}</Button>
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {skills.map(skill => (
                      <Card
                        key={skill.metadata.labels?.id || skill.metadata.name}
                        className="p-4 hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-start justify-between">
                          {/* Skill Info */}
                          <div className="flex items-start gap-3 min-w-0 flex-1">
                            <PackageIcon className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                              <h3 className="text-base font-medium text-text-primary truncate">
                                {skill.metadata.name}
                              </h3>
                              <p className="text-sm text-text-secondary mt-1 line-clamp-2">
                                {skill.spec.description}
                              </p>

                              {/* Tags and Metadata */}
                              <div className="flex flex-wrap gap-1.5 mt-2">
                                {skill.spec.version && (
                                  <Tag variant="default">
                                    {t('skills.version', { version: skill.spec.version })}
                                  </Tag>
                                )}
                                {skill.spec.author && (
                                  <Tag variant="default">
                                    {t('skills.author', { author: skill.spec.author })}
                                  </Tag>
                                )}
                                {skill.spec.tags?.map(tag => (
                                  <Tag key={tag} variant="info">
                                    {tag}
                                  </Tag>
                                ))}
                              </div>

                              {/* File Info */}
                              <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
                                {skill.status?.fileSize && (
                                  <span>{formatFileSize(skill.status.fileSize)}</span>
                                )}
                                {skill.status?.state && (
                                  <span
                                    className={
                                      skill.status.state === 'Available'
                                        ? 'text-success'
                                        : 'text-error'
                                    }
                                  >
                                    {skill.status.state === 'Available'
                                      ? t('skills.state_available')
                                      : t('skills.state_unavailable')}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Action Buttons */}
                          <div className="flex gap-1 flex-shrink-0 ml-4">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleDownloadSkill(skill)}
                              title={t('skills.download_skill')}
                            >
                              <DownloadIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleEditSkill(skill)}
                              title={t('skills.update_skill')}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-error hover:text-error hover:bg-error/10"
                              onClick={() => handleDeleteSkill(skill)}
                              title={t('skills.delete_skill')}
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
              {t('actions.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload/Edit Modal */}
      {uploadModalOpen && (
        <SkillUploadModal open={uploadModalOpen} onClose={handleModalClose} skill={editingSkill} />
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteConfirmVisible}
        onOpenChange={open => !open && !isDeleting && setDeleteConfirmVisible(false)}
      >
        <DialogContent className="bg-surface">
          <DialogHeader>
            <DialogTitle>{t('skills.delete_confirm_title')}</DialogTitle>
            <DialogDescription>
              {t('skills.delete_confirm_message', { skillName: skillToDelete?.metadata.name })}
              {skillToDelete && (
                <div className="mt-3 p-3 bg-muted rounded-md text-sm">
                  <strong>{t('skills.delete_note')}</strong>
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
              {t('actions.cancel')}
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
                  {t('actions.deleting')}
                </div>
              ) : (
                t('actions.delete')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
