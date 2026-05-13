// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { useProjectContext } from '../contexts/projectContext'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { ProjectConfig, ProjectWorkspaceSource } from '@/types/api'

// Predefined colors for projects
const PROJECT_COLORS = [
  { id: 'red', value: '#EF4444' },
  { id: 'orange', value: '#F97316' },
  { id: 'yellow', value: '#EAB308' },
  { id: 'green', value: '#22C55E' },
  { id: 'blue', value: '#3B82F6' },
  { id: 'purple', value: '#8B5CF6' },
  { id: 'pink', value: '#EC4899' },
  { id: 'gray', value: '#6B7280' },
]

interface ProjectCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProjectCreateDialog({ open, onOpenChange }: ProjectCreateDialogProps) {
  const { t } = useTranslation('projects')
  const { createProject } = useProjectContext()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedColor, setSelectedColor] = useState<string | null>(null)
  const [workspaceEnabled, setWorkspaceEnabled] = useState(false)
  const [targetType, setTargetType] = useState<'local' | 'cloud'>('local')
  const [deviceId, setDeviceId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [workspaceSource, setWorkspaceSource] = useState<ProjectWorkspaceSource>('git')
  const [gitUrl, setGitUrl] = useState('')
  const [gitRepo, setGitRepo] = useState('')
  const [gitBranch, setGitBranch] = useState('main')
  const [localPath, setLocalPath] = useState('')
  const [checkoutPath, setCheckoutPath] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const enableProjectWorkspace = getRuntimeConfigSync().enableProjectWorkspace

  const handleCreate = async () => {
    if (!name.trim()) return

    setIsCreating(true)
    try {
      const config = buildWorkspaceConfig()
      await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        color: selectedColor || undefined,
        config,
      })
      // Reset form and close dialog
      setName('')
      setDescription('')
      setSelectedColor(null)
      resetWorkspaceFields()
      onOpenChange(false)
    } finally {
      setIsCreating(false)
    }
  }

  const handleClose = () => {
    if (!isCreating) {
      setName('')
      setDescription('')
      setSelectedColor(null)
      resetWorkspaceFields()
      onOpenChange(false)
    }
  }

  const resetWorkspaceFields = () => {
    setWorkspaceEnabled(false)
    setTargetType('local')
    setDeviceId('')
    setTeamId('')
    setWorkspaceSource('git')
    setGitUrl('')
    setGitRepo('')
    setGitBranch('main')
    setLocalPath('')
    setCheckoutPath('')
  }

  const buildWorkspaceConfig = (): ProjectConfig | undefined => {
    if (!enableProjectWorkspace || !workspaceEnabled) return undefined

    const source = targetType === 'cloud' ? 'git' : workspaceSource
    return {
      mode: 'workspace',
      execution: {
        targetType,
        deviceId: targetType === 'local' ? deviceId.trim() : null,
      },
      team: {
        id: teamId.trim() ? Number(teamId.trim()) : null,
        namespace: 'default',
      },
      workspace: {
        source,
        localPath: source === 'local_path' ? localPath.trim() : null,
        checkoutPath: source === 'git' && checkoutPath.trim() ? checkoutPath.trim() : null,
      },
      git:
        source === 'git'
          ? {
              url: gitUrl.trim(),
              repo: gitRepo.trim() || null,
              branch: gitBranch.trim() || 'main',
            }
          : null,
    }
  }

  const canCreateWorkspace =
    !workspaceEnabled ||
    (teamId.trim() &&
      (targetType === 'cloud' || deviceId.trim()) &&
      (workspaceSource === 'git' || targetType === 'cloud' ? gitUrl.trim() : localPath.trim()))

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('create.title')}</DialogTitle>
          <DialogDescription>{t('create.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Project Name */}
          <div className="space-y-2">
            <Label htmlFor="name">{t('create.nameLabel')}</Label>
            <Input
              id="name"
              placeholder={t('create.namePlaceholder')}
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={100}
              disabled={isCreating}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">{t('create.descriptionLabel')}</Label>
            <Textarea
              id="description"
              placeholder={t('create.descriptionPlaceholder')}
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              disabled={isCreating}
            />
          </div>

          {/* Color Selection */}
          <div className="space-y-2">
            <Label>{t('create.colorLabel')}</Label>
            <div className="flex flex-wrap gap-2">
              {PROJECT_COLORS.map(color => (
                <button
                  key={color.id}
                  type="button"
                  onClick={() =>
                    setSelectedColor(selectedColor === color.value ? null : color.value)
                  }
                  className={`w-8 h-8 rounded-full border-2 transition-all ${
                    selectedColor === color.value
                      ? 'border-text-primary scale-110'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: color.value }}
                  title={t(`colors.${color.id}`)}
                  disabled={isCreating}
                />
              ))}
            </div>
          </div>

          {enableProjectWorkspace && (
            <div className="space-y-3 border-t border-border pt-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  data-testid="workspace-project-toggle"
                  type="checkbox"
                  checked={workspaceEnabled}
                  onChange={e => setWorkspaceEnabled(e.target.checked)}
                  disabled={isCreating}
                />
                {t('workspace.enable')}
              </label>

              {workspaceEnabled && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      data-testid="workspace-target-local"
                      type="button"
                      variant={targetType === 'local' ? 'primary' : 'outline'}
                      onClick={() => setTargetType('local')}
                      disabled={isCreating}
                    >
                      {t('workspace.local')}
                    </Button>
                    <Button
                      data-testid="workspace-target-cloud"
                      type="button"
                      variant={targetType === 'cloud' ? 'primary' : 'outline'}
                      onClick={() => {
                        setTargetType('cloud')
                        setWorkspaceSource('git')
                      }}
                      disabled={isCreating}
                    >
                      {t('workspace.cloud')}
                    </Button>
                  </div>

                  {targetType === 'local' && (
                    <div className="space-y-2">
                      <Label htmlFor="workspace-device-id">{t('workspace.deviceId')}</Label>
                      <Input
                        data-testid="workspace-device-id-input"
                        id="workspace-device-id"
                        value={deviceId}
                        onChange={e => setDeviceId(e.target.value)}
                        disabled={isCreating}
                      />
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="workspace-team-id">{t('workspace.teamId')}</Label>
                    <Input
                      data-testid="workspace-team-id-input"
                      id="workspace-team-id"
                      value={teamId}
                      onChange={e => setTeamId(e.target.value)}
                      disabled={isCreating}
                    />
                  </div>

                  {targetType === 'local' && (
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        data-testid="workspace-source-git"
                        type="button"
                        variant={workspaceSource === 'git' ? 'primary' : 'outline'}
                        onClick={() => setWorkspaceSource('git')}
                        disabled={isCreating}
                      >
                        {t('workspace.git')}
                      </Button>
                      <Button
                        data-testid="workspace-source-local-path"
                        type="button"
                        variant={workspaceSource === 'local_path' ? 'primary' : 'outline'}
                        onClick={() => setWorkspaceSource('local_path')}
                        disabled={isCreating}
                      >
                        {t('workspace.localPath')}
                      </Button>
                    </div>
                  )}

                  {workspaceSource === 'git' || targetType === 'cloud' ? (
                    <div className="space-y-2">
                      <Input
                        data-testid="workspace-git-url-input"
                        placeholder={t('workspace.gitUrl')}
                        value={gitUrl}
                        onChange={e => setGitUrl(e.target.value)}
                        disabled={isCreating}
                      />
                      <Input
                        data-testid="workspace-git-repo-input"
                        placeholder={t('workspace.gitRepo')}
                        value={gitRepo}
                        onChange={e => setGitRepo(e.target.value)}
                        disabled={isCreating}
                      />
                      <Input
                        data-testid="workspace-git-branch-input"
                        placeholder={t('workspace.gitBranch')}
                        value={gitBranch}
                        onChange={e => setGitBranch(e.target.value)}
                        disabled={isCreating}
                      />
                      <Input
                        data-testid="workspace-checkout-path-input"
                        placeholder={t('workspace.checkoutPath')}
                        value={checkoutPath}
                        onChange={e => setCheckoutPath(e.target.value)}
                        disabled={isCreating}
                      />
                    </div>
                  ) : (
                    <Input
                      data-testid="workspace-local-path-input"
                      placeholder={t('workspace.localPathPlaceholder')}
                      value={localPath}
                      onChange={e => setLocalPath(e.target.value)}
                      disabled={isCreating}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose} disabled={isCreating}>
            {t('create.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={isCreating || !name.trim() || !canCreateWorkspace}
          >
            {isCreating ? t('common:actions.creating') : t('create.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
