import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { findSelectableProject } from '@/features/workbench/workbenchRuntimeHelpers'
import {
  MISSING_WORKSPACE_FILE_REVISION,
  enabledProjectPluginKeys,
  setProjectPluginEnabled,
} from '@/lib/project-codex-config'
import { executionDeviceId, resolveProjectWorkspacePath } from '@/lib/project-workspace'
import { useTranslation } from '@/hooks/useTranslation'
import type { InstalledPlugin } from '@/types/api'

interface ProjectConfigTarget {
  deviceId: string
  root: string
  codexDirectoryExists: boolean
  content: string
  revision: string
}

export interface ProjectPluginScope {
  projectId: number
  projectName: string
  pluginKeys: Set<string>
  loading: boolean
  error: string | null
  addInstalledPlugin: (plugin: InstalledPlugin) => Promise<InstalledPlugin>
}

function joinPath(root: string, child: string): string {
  return `${root.replace(/[\\/]$/, '')}/${child}`
}

export function installedPluginKey(plugin: InstalledPlugin): string {
  const { pluginKey, providerKey } = plugin.spec.source
  return pluginKey.includes('@') ? pluginKey : `${pluginKey}@${providerKey}`
}

function installedPluginId(plugin: InstalledPlugin): string | number | null {
  const labels = plugin.metadata.labels
  if (!labels || typeof labels !== 'object') return null
  const id = (labels as Record<string, unknown>).id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

export function useProjectPluginScope(projectId: number | null): ProjectPluginScope | null {
  const { t } = useTranslation()
  const { state, workspaceFileApi, getProjectWorkspaceRoot, createDeviceDirectory } = useWorkbench()
  const { listWorkspaceEntries, readWorkspaceTextFile, writeWorkspaceTextFile } = workspaceFileApi
  const project = projectId
    ? findSelectableProject(state.projects, state.runtimeWork, projectId)
    : null
  const loadContextRef = useRef({
    getProjectWorkspaceRoot,
    listWorkspaceEntries,
    project,
    readWorkspaceTextFile,
    t,
  })
  useEffect(() => {
    loadContextRef.current = {
      getProjectWorkspaceRoot,
      listWorkspaceEntries,
      project,
      readWorkspaceTextFile,
      t,
    }
  }, [getProjectWorkspaceRoot, listWorkspaceEntries, project, readWorkspaceTextFile, t])
  const [target, setTarget] = useState<ProjectConfigTarget | null>(null)
  const targetRef = useRef<ProjectConfigTarget | null>(null)
  const [loading, setLoading] = useState(projectId !== null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    targetRef.current = target
  }, [target])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const context = loadContextRef.current
      setTarget(null)
      targetRef.current = null
      setError(null)
      if (!projectId) {
        setLoading(false)
        return
      }
      setLoading(true)
      if (!context.project) {
        setError(context.t('workbench.project_settings_project_missing'))
        setLoading(false)
        return
      }
      const deviceId = executionDeviceId(context.project)
      if (!deviceId) {
        setError(context.t('workbench.project_settings_workspace_missing'))
        setLoading(false)
        return
      }
      try {
        const root = await resolveProjectWorkspacePath(context.project, deviceId, {
          getProjectWorkspaceRoot: context.getProjectWorkspaceRoot,
        })
        if (!root) throw new Error(context.t('workbench.project_settings_workspace_missing'))
        const rootEntries = await context.listWorkspaceEntries(deviceId, root)
        const codexDirectory = joinPath(root, '.codex')
        const codexDirectoryExists = rootEntries.entries.some(
          entry => entry.isDirectory && entry.name === '.codex'
        )
        let content = ''
        let revision = MISSING_WORKSPACE_FILE_REVISION
        if (codexDirectoryExists) {
          const entries = await context.listWorkspaceEntries(deviceId, codexDirectory)
          if (entries.entries.some(entry => !entry.isDirectory && entry.name === 'config.toml')) {
            const file = await context.readWorkspaceTextFile(
              deviceId,
              joinPath(codexDirectory, 'config.toml')
            )
            if (!file.editable || file.truncated)
              throw new Error(context.t('workbench.project_settings_file_too_large'))
            content = file.content
            revision = file.revision
          }
        }
        if (!cancelled) {
          const next = { deviceId, root, codexDirectoryExists, content, revision }
          targetRef.current = next
          setTarget(next)
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [project?.id, projectId])

  const addInstalledPlugin = useCallback(
    async (plugin: InstalledPlugin) => {
      let current = targetRef.current
      if (!current) throw new Error(error ?? t('workbench.plugins_project_config_loading'))
      const id = installedPluginId(plugin)
      if (id == null) throw new Error(t('workbench.plugins_install_missing_id'))
      const content = setProjectPluginEnabled(current.content, installedPluginKey(plugin), true)
      if (!current.codexDirectoryExists) {
        await createDeviceDirectory(current.deviceId, joinPath(current.root, '.codex'))
        current = { ...current, codexDirectoryExists: true }
        targetRef.current = current
        setTarget(current)
      }
      const response = await writeWorkspaceTextFile(
        current.deviceId,
        joinPath(current.root, '.codex/config.toml'),
        content,
        current.revision
      )
      const next = {
        ...current,
        content: response.content,
        revision: response.revision,
      }
      targetRef.current = next
      setTarget(next)
      return plugin
    },
    [createDeviceDirectory, error, t, writeWorkspaceTextFile]
  )

  const pluginKeys = useMemo(
    () => enabledProjectPluginKeys(target?.content ?? ''),
    [target?.content]
  )
  if (!projectId) return null
  return {
    projectId,
    projectName: project?.name ?? String(projectId),
    pluginKeys,
    loading,
    error,
    addInstalledPlugin,
  }
}
