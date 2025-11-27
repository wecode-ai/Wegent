// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import '@/features/common/scrollbar.css';

import { useCallback, useEffect, useState } from 'react';
import { PencilIcon, TrashIcon, DownloadIcon, PackageIcon } from 'lucide-react';
import LoadingState from '@/features/common/LoadingState';
import { Skill } from '@/types/api';
import { fetchSkillsList, deleteSkill, downloadSkill, formatFileSize } from '@/apis/skills';
import SkillUploadModal from './SkillUploadModal';
import UnifiedAddButton from '@/components/common/UnifiedAddButton';
import { useTranslation } from '@/hooks/useTranslation';
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

export default function SkillList() {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null);

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
    loadSkills();
  }, [loadSkills]);

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

    try {
      const skillId = parseInt(skillToDelete.metadata.labels?.id || '0');
      await deleteSkill(skillId);
      toast({
        title: t('common.success'),
        description: t('skills.success_delete', { skillName: skillToDelete.metadata.name }),
      });
      await loadSkills();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('skills.failed_delete'),
        description: error instanceof Error ? error.message : t('common.unknown_error'),
      });
    } finally {
      setDeleteConfirmVisible(false);
      setSkillToDelete(null);
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
    }
  };

  if (isLoading) {
    return <LoadingState message={t('skills.loading')} />;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">{t('skills.title')}</h2>
          <p className="text-sm text-text-muted mt-1">{t('skills.description')}</p>
        </div>
        <UnifiedAddButton onClick={handleCreateSkill}>{t('skills.upload_skill')}</UnifiedAddButton>
      </div>

      {/* Skills List */}
      {skills.length === 0 ? (
        <Card className="p-8 text-center">
          <PackageIcon className="w-12 h-12 mx-auto text-text-muted mb-3" />
          <h3 className="text-base font-medium text-text-primary mb-2">{t('skills.no_skills')}</h3>
          <p className="text-sm text-text-muted mb-4">{t('skills.no_skills_description')}</p>
          <Button onClick={handleCreateSkill}>{t('skills.upload_first_skill')}</Button>
        </Card>
      ) : (
        <div className="space-y-3 p-1">
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
                            skill.status.state === 'Available' ? 'text-success' : 'text-error'
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

      {/* Upload/Edit Modal */}
      {uploadModalOpen && (
        <SkillUploadModal open={uploadModalOpen} onClose={handleModalClose} skill={editingSkill} />
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmVisible} onOpenChange={setDeleteConfirmVisible}>
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
            <Button variant="outline" onClick={() => setDeleteConfirmVisible(false)}>
              {t('actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              {t('actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
