import { useMemo, useState } from 'react'

import { getRuntimeProjectOwner } from '@/lib/runtime-project-state'

import { runtimeProjectUiId } from '@/lib/runtime-project'

import type { ProjectWithTasks, RuntimeProjectWork } from '@/types/api'

import type { DesktopSidebarProps } from './desktopSidebarTypes'

export function useDesktopSidebarProjectEditor({
  runtimeWork,
  projectDevicePluginApi,
  onUpdateLocalRuntimeProject,
}: Pick<
  DesktopSidebarProps,
  'runtimeWork' | 'projectDevicePluginApi' | 'onUpdateLocalRuntimeProject'
>) {
  const [renamingProject, setRenamingProject] = useState<ProjectWithTasks | null>(null)
  const [editingLocalProject, setEditingLocalProject] = useState<RuntimeProjectWork | null>(null)
  const editingProjectWork = editingLocalProject
    ? (runtimeWork?.projects.find(
        item => runtimeProjectUiId(item.project) === runtimeProjectUiId(editingLocalProject.project)
      ) ?? editingLocalProject)
    : null
  const editingProjectOwnerId = editingProjectWork
    ? getRuntimeProjectOwner(editingProjectWork).deviceId
    : ''
  const editingProjectPluginApi = useMemo(
    () => (editingProjectOwnerId ? projectDevicePluginApi?.(editingProjectOwnerId) : undefined),
    [projectDevicePluginApi, editingProjectOwnerId]
  )
  const openProjectEditor = (project: ProjectWithTasks, projectWork?: RuntimeProjectWork) => {
    if (projectWork && onUpdateLocalRuntimeProject) {
      setEditingLocalProject(projectWork)
      return
    }
    setRenamingProject(project)
  }
  return {
    renamingProject,
    setRenamingProject,
    editingLocalProject,
    setEditingLocalProject,
    editingProjectWork,
    editingProjectPluginApi,
    openProjectEditor,
  }
}
