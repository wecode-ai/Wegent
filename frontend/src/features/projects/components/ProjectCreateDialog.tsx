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
import { isVersionAtLeast } from '@/lib/utils'
import { ProjectDirectoryPickerDialog } from './ProjectDirectoryPickerDialog'
import { FolderOpen } from 'lucide-react'
import type { DeviceInfo } from '@/apis/devices'

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

const MIN_WORKSPACE_PROJECT_DEVICE_VERSION = 'v1.7.13'
type WorkspaceProjectDeviceType = 'local' | 'cloud' | 'remote'
const WORKSPACE_PROJECT_DEVICE_TYPES = new Set<WorkspaceProjectDeviceType>([
  'local',
  'cloud',
  'remote',
])

function getNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const lastSegment = trimmed.split('/').pop() || ''
  return lastSegment
}

function isWorkspaceProjectDeviceType(
  deviceType: DeviceInfo['device_type']
): deviceType is WorkspaceProjectDeviceType {
  return WORKSPACE_PROJECT_DEVICE_TYPES.has(deviceType as WorkspaceProjectDeviceType)
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

  // Online ClaudeCode devices that support configured directory browsing commands.
  const onlineDevices = useMemo(() => {
    return devices.filter(
      (d): d is DeviceInfo & { device_type: WorkspaceProjectDeviceType } =>
        (d.status === 'online' || d.status === 'busy') &&
        isWorkspaceProjectDeviceType(d.device_type) &&
        d.bind_shell !== 'openclaw'
    )
  }, [devices])

  // Group mode state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedColor, setSelectedColor] = useState<string | null>(null)

  // Workspace mode state
  const [deviceId, setDeviceId] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false)

  const [isCreating, setIsCreating] = useState(false)

  const selectedDevice = useMemo(
    () => onlineDevices.find(device => device.device_id === deviceId) ?? null,
    [deviceId, onlineDevices]
  )

  const selectedDeviceSupportsWorkspaceProject = Boolean(
    selectedDevice?.executor_version &&
    isVersionAtLeast(selectedDevice.executor_version, MIN_WORKSPACE_PROJECT_DEVICE_VERSION)
  )

  const showDeviceVersionUnsupported =
    isWorkspaceMode && Boolean(selectedDevice) && !selectedDeviceSupportsWorkspaceProject

  // Auto-select first online device when dialog opens
  useEffect(() => {
    if (open && isWorkspaceMode && !deviceId && onlineDevices.length > 0) {
      setDeviceId(onlineDevices[0].device_id)
    }
  }, [open, isWorkspaceMode, deviceId, onlineDevices])

  const projectName = localPath.trim() ? getNameFromPath(localPath) : ''
  const selectedTargetType = selectedDevice?.device_type ?? 'local'
  const directoryPickerInitialPath = selectedTargetType === 'local' ? localPath : localPath || '/'

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
    if (
      !deviceId ||
      !localPath.trim() ||
      !selectedDevice ||
      !selectedDeviceSupportsWorkspaceProject
    ) {
      return
    }

    setIsCreating(true)
    try {
      const config: ProjectConfig = {
        mode: 'workspace',
        execution: {
          targetType: selectedTargetType,
          deviceId,
        },
      }
      const workspacePath = localPath.trim()
      config.workspace =
        selectedTargetType === 'local'
          ? {
              source: 'local_path',
              localPath: workspacePath,
            }
          : {
              source: 'device_path',
              devicePath: workspacePath,
            }
      const tempName = projectName || selectedDevice.name || 'device-workspace'
      await projectApis.createProject({
        name: tempName,
        config,
      })
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
    setDirectoryPickerOpen(false)
  }

  const canCreate = isWorkspaceMode
    ? Boolean(deviceId) && Boolean(localPath.trim()) && selectedDeviceSupportsWorkspaceProject
    : Boolean(name.trim())

  const handleDeviceChange = (nextDeviceId: string) => {
    setDeviceId(nextDeviceId)
    setLocalPath('')
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>
              {t(isWorkspaceMode ? 'workspaceCreate.title' : 'create.title')}
            </DialogTitle>
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
                    <Select
                      value={deviceId}
                      onValueChange={handleDeviceChange}
                      disabled={isCreating}
                    >
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
                              {device.device_type === 'remote' && (
                                <span className="text-xs text-text-muted ml-1">
                                  ({t('workspace.remote')})
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {showDeviceVersionUnsupported && (
                    <p
                      className="text-sm text-destructive"
                      data-testid="workspace-device-version-warning"
                    >
                      {t('workspace.deviceVersionUnsupported', {
                        version:
                          selectedDevice?.executor_version || t('workspace.unknownDeviceVersion'),
                        requiredVersion: MIN_WORKSPACE_PROJECT_DEVICE_VERSION,
                      })}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>{t('workspace.directoryPath')}</Label>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-full justify-start gap-2 px-3 font-normal"
                    onClick={() => setDirectoryPickerOpen(true)}
                    disabled={
                      isCreating ||
                      !deviceId ||
                      !selectedDeviceSupportsWorkspaceProject ||
                      onlineDevices.length === 0
                    }
                    data-testid="workspace-directory-picker-trigger"
                  >
                    <FolderOpen className="h-4 w-4 flex-none text-text-muted" />
                    <span
                      className={`min-w-0 flex-1 truncate text-left ${
                        localPath ? 'text-text-primary' : 'text-text-muted'
                      }`}
                    >
                      {localPath || t('workspace.selectDirectory')}
                    </span>
                  </Button>
                  {projectName ? (
                    <p className="text-xs text-text-secondary">
                      {t('workspace.projectNamePreview', { name: projectName })}
                    </p>
                  ) : (
                    <p className="text-xs text-text-muted">{t('workspace.selectDirectoryHint')}</p>
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
      <ProjectDirectoryPickerDialog
        open={directoryPickerOpen}
        deviceId={deviceId}
        initialPath={directoryPickerInitialPath}
        onOpenChange={setDirectoryPickerOpen}
        onConfirm={setLocalPath}
      />
    </>
  )
}
