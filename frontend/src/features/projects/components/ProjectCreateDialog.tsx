// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo, useEffect } from 'react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { useProjectContext } from '../contexts/projectContext'
import { projectApis } from '@/apis/projects'
import { useDevices } from '@/contexts/DeviceContext'
import type { ProjectConfig } from '@/types/api'

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

function getNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const lastSegment = trimmed.split('/').pop() || ''
  return lastSegment
}

interface ProjectCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode?: 'group' | 'workspace'
}

export function ProjectCreateDialog({
  open,
  onOpenChange,
  mode = 'group',
}: ProjectCreateDialogProps) {
  const { t } = useTranslation('projects')
  const { createProject, refreshProjects } = useProjectContext()
  const { devices } = useDevices()
  const isWorkspaceMode = mode === 'workspace'

  // Online devices only, prefer cloud ClaudeCode devices first
  const onlineDevices = useMemo(() => {
    const online = devices.filter(d => d.status === 'online' || d.status === 'busy')
    return online.sort((a, b) => {
      const aIsCloudCode = a.device_type === 'cloud' && a.bind_shell === 'claudecode' ? 0 : 1
      const bIsCloudCode = b.device_type === 'cloud' && b.bind_shell === 'claudecode' ? 0 : 1
      return aIsCloudCode - bIsCloudCode
    })
  }, [devices])

  // Group mode state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedColor, setSelectedColor] = useState<string | null>(null)

  // Workspace mode state
  const [deviceId, setDeviceId] = useState('')
  const [localPath, setLocalPath] = useState('')

  const [isCreating, setIsCreating] = useState(false)

  // Auto-select first online device when dialog opens
  useEffect(() => {
    if (open && isWorkspaceMode && !deviceId && onlineDevices.length > 0) {
      setDeviceId(onlineDevices[0].device_id)
    }
  }, [open, isWorkspaceMode, deviceId, onlineDevices])

  const projectName = localPath.trim() ? getNameFromPath(localPath) : ''

  const handleCreateGroup = async () => {
    if (!name.trim()) return

    setIsCreating(true)
    try {
      await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        color: selectedColor || undefined,
      })
      resetForm()
      onOpenChange(false)
    } finally {
      setIsCreating(false)
    }
  }

  const handleCreateWorkspace = async () => {
    if (!deviceId) return

    setIsCreating(true)
    try {
      const config: ProjectConfig = {
        mode: 'workspace',
        execution: {
          targetType: 'local',
          deviceId,
        },
      }
      if (localPath.trim()) {
        config.workspace = {
          source: 'local_path',
          localPath: localPath.trim(),
        }
      }
      const tempName = projectName || 'project'
      const created = await projectApis.createProject({
        name: tempName,
        config,
      })
      // If no path was specified, rename to project{id} based on default folder name
      if (!localPath.trim() && created.id) {
        await projectApis.updateProject(created.id, { name: `project${created.id}` })
      }
      await refreshProjects()
      resetForm()
      onOpenChange(false)
    } finally {
      setIsCreating(false)
    }
  }

  const handleCreate = isWorkspaceMode ? handleCreateWorkspace : handleCreateGroup

  const handleClose = () => {
    if (!isCreating) {
      resetForm()
      onOpenChange(false)
    }
  }

  const resetForm = () => {
    setName('')
    setDescription('')
    setSelectedColor(null)
    setDeviceId('')
    setLocalPath('')
  }

  const canCreate = isWorkspaceMode ? Boolean(deviceId) : Boolean(name.trim())

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t(isWorkspaceMode ? 'workspaceCreate.title' : 'create.title')}</DialogTitle>
          <DialogDescription>
            {t(isWorkspaceMode ? 'workspaceCreate.description' : 'create.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {isWorkspaceMode ? (
            <>
              <div className="space-y-2">
                <Label>{t('workspace.device')}</Label>
                {onlineDevices.length === 0 ? (
                  <p className="text-sm text-destructive">{t('workspace.noOnlineDevices')}</p>
                ) : (
                  <Select value={deviceId} onValueChange={setDeviceId} disabled={isCreating}>
                    <SelectTrigger data-testid="workspace-device-select">
                      <SelectValue placeholder={t('workspace.devicePlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {onlineDevices.map(device => (
                        <SelectItem key={device.device_id} value={device.device_id}>
                          <span className="flex items-center gap-2">
                            <span
                              className={`inline-block w-2 h-2 rounded-full ${
                                device.status === 'online' ? 'bg-green-500' : 'bg-yellow-500'
                              }`}
                            />
                            {device.name || device.device_id}
                            {device.device_type === 'cloud' && (
                              <span className="text-xs text-text-muted ml-1">
                                ({t('workspace.cloud')})
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="workspace-local-path">
                  {t('workspace.directoryPath')}
                  <span className="text-text-muted font-normal ml-1">({t('common:optional')})</span>
                </Label>
                <Input
                  data-testid="workspace-local-path-input"
                  id="workspace-local-path"
                  placeholder={t('workspace.directoryPathPlaceholder')}
                  value={localPath}
                  onChange={e => setLocalPath(e.target.value)}
                  disabled={isCreating}
                />
                {projectName ? (
                  <p className="text-xs text-text-secondary">
                    {t('workspace.projectNamePreview', { name: projectName })}
                  </p>
                ) : (
                  <p className="text-xs text-text-muted">{t('workspace.defaultPathHint')}</p>
                )}
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose} disabled={isCreating}>
            {t('create.cancel')}
          </Button>
          <Button variant="primary" onClick={handleCreate} disabled={isCreating || !canCreate}>
            {isCreating
              ? t('common:actions.creating')
              : t(isWorkspaceMode ? 'workspaceCreate.submit' : 'create.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
