// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';
import '@/features/common/scrollbar.css';

import { useCallback, useEffect, useState } from 'react';
import { PencilIcon, TrashIcon, DownloadIcon, PackageIcon } from 'lucide-react';
import LoadingState from '@/features/common/LoadingState';
import { Skill } from '@/types/api';
import {
  fetchSkillsList,
  deleteSkill,
  downloadSkill,
  formatFileSize,
} from '@/apis/skills';
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
        title: 'Failed to load skills',
        description: error instanceof Error ? error.message : 'Unknown error',
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
        title: 'Success',
        description: `Skill "${skillToDelete.metadata.name}" deleted successfully`,
      });
      await loadSkills();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Failed to delete skill',
        description: error instanceof Error ? error.message : 'Unknown error',
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
        title: 'Success',
        description: `Downloading skill "${skill.metadata.name}"`,
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Failed to download skill',
        description: error instanceof Error ? error.message : 'Unknown error',
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
          <h2 className="text-xl font-semibold text-text-primary">Skills</h2>
          <p className="text-sm text-text-muted mt-1">
            Manage Claude Code Skills to extend your bot capabilities
          </p>
        </div>
        <UnifiedAddButton onClick={handleCreateSkill} label="Upload Skill" />
      </div>

      {/* Skills List */}
      {skills.length === 0 ? (
        <Card className="p-8 text-center">
          <PackageIcon className="w-12 h-12 mx-auto text-text-muted mb-3" />
          <h3 className="text-base font-medium text-text-primary mb-2">No skills yet</h3>
          <p className="text-sm text-text-muted mb-4">
            Upload a Claude Code Skill ZIP package to get started
          </p>
          <Button onClick={handleCreateSkill}>Upload Your First Skill</Button>
        </Card>
      ) : (
        <div className="space-y-3 p-1">
          {skills.map((skill) => (
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
                        <Tag variant="secondary" size="sm">
                          v{skill.spec.version}
                        </Tag>
                      )}
                      {skill.spec.author && (
                        <Tag variant="secondary" size="sm">
                          {skill.spec.author}
                        </Tag>
                      )}
                      {skill.spec.tags?.map((tag) => (
                        <Tag key={tag} variant="default" size="sm">
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
                          {skill.status.state}
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
                    title="Download"
                  >
                    <DownloadIcon className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleEditSkill(skill)}
                    title="Update"
                  >
                    <PencilIcon className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-error hover:text-error hover:bg-error/10"
                    onClick={() => handleDeleteSkill(skill)}
                    title="Delete"
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
        <SkillUploadModal
          open={uploadModalOpen}
          onClose={handleModalClose}
          skill={editingSkill}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmVisible} onOpenChange={setDeleteConfirmVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Skill</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the skill &quot;{skillToDelete?.metadata.name}
              &quot;? This action cannot be undone.
              {skillToDelete && (
                <div className="mt-3 p-3 bg-muted rounded-md text-sm">
                  <strong>Note:</strong> If this skill is referenced by any Ghost, the
                  deletion will fail. Please remove the skill from all Ghosts first.
                </div>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmVisible(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
