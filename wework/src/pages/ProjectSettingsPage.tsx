import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ExternalLink, Loader2, Save } from 'lucide-react'
import { createLocalCodexPluginApi, type LocalCodexPluginsState } from '@/api/local/codexPlugins'
import { SettingsPage, SettingsPageHeader } from '@/components/settings/settings-ui'
import { installedPluginKey, joinPath } from '@/features/plugins/useProjectPluginScope'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { findSelectableProject } from '@/features/workbench/workbenchRuntimeHelpers'
import { useTranslation } from '@/hooks/useTranslation'
import {
  MISSING_WORKSPACE_FILE_REVISION,
  enabledProjectPluginKeys,
  setProjectPluginEnabled,
} from '@/lib/project-codex-config'
import { resolveProjectWorkspacePath, executionDeviceId } from '@/lib/project-workspace'
import { navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { InstalledPlugin } from '@/types/api'

type ConfigTab = 'instructions' | 'config'

interface EditableFile {
  content: string
  revision: string
}

const EMPTY_FILE: EditableFile = { content: '', revision: MISSING_WORKSPACE_FILE_REVISION }

export function ProjectSettingsPage({ projectId }: { projectId: number }) {
  const { t } = useTranslation()
  const { state, workspaceFileApi, getProjectWorkspaceRoot, createDeviceDirectory } = useWorkbench()
  const { listWorkspaceEntries, readWorkspaceTextFile, writeWorkspaceTextFile } = workspaceFileApi
  const project = findSelectableProject(state.projects, state.runtimeWork, Number(projectId))
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
  const [target, setTarget] = useState<{
    deviceId: string
    root: string
    codexDirectoryExists: boolean
  } | null>(null)
  const [instructions, setInstructions] = useState<EditableFile>(EMPTY_FILE)
  const [config, setConfig] = useState<EditableFile>(EMPTY_FILE)
  const [savedInstructions, setSavedInstructions] = useState('')
  const [savedConfig, setSavedConfig] = useState('')
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [tab, setTab] = useState<ConfigTab>('instructions')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pluginError, setPluginError] = useState<string | null>(null)

  const dirty = instructions.content !== savedInstructions || config.content !== savedConfig
  const projectPluginKeys = useMemo(
    () => enabledProjectPluginKeys(config.content),
    [config.content]
  )

  const applyPluginState = useCallback((pluginState: LocalCodexPluginsState) => {
    setPlugins(pluginState.installedPlugins)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const context = loadContextRef.current
      setLoading(true)
      setTarget(null)
      setInstructions(EMPTY_FILE)
      setConfig(EMPTY_FILE)
      setSavedInstructions('')
      setSavedConfig('')
      setSaved(false)
      setError(null)
      setPluginError(null)
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
        const loadOptionalFile = async (directory: string, name: string): Promise<EditableFile> => {
          const entries = await context.listWorkspaceEntries(deviceId, directory)
          if (!entries.entries.some(entry => !entry.isDirectory && entry.name === name))
            return EMPTY_FILE
          const file = await context.readWorkspaceTextFile(deviceId, joinPath(directory, name))
          if (!file.editable || file.truncated)
            throw new Error(context.t('workbench.project_settings_file_too_large'))
          return { content: file.content, revision: file.revision }
        }
        const rootEntries = await context.listWorkspaceEntries(deviceId, root)
        const codexDirectory = joinPath(root, '.codex')
        const hasCodexDirectory = rootEntries.entries.some(
          entry => entry.isDirectory && entry.name === '.codex'
        )
        const pluginApi = isTauriRuntime() ? createLocalCodexPluginApi() : null
        const [nextInstructions, nextConfig] = await Promise.all([
          loadOptionalFile(root, 'AGENTS.md'),
          hasCodexDirectory
            ? loadOptionalFile(codexDirectory, 'config.toml')
            : Promise.resolve(EMPTY_FILE),
        ])
        if (cancelled) return
        setTarget({ deviceId, root, codexDirectoryExists: hasCodexDirectory })
        setInstructions(nextInstructions)
        setConfig(nextConfig)
        setSavedInstructions(nextInstructions.content)
        setSavedConfig(nextConfig.content)
        if (pluginApi) {
          void pluginApi
            .readState()
            .then(pluginState => {
              if (!cancelled) applyPluginState(pluginState)
            })
            .catch(pluginLoadError => {
              if (!cancelled) {
                setPluginError(
                  pluginLoadError instanceof Error
                    ? pluginLoadError.message
                    : String(pluginLoadError)
                )
              }
            })
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
  }, [applyPluginState, project?.id])

  const save = async () => {
    if (!target || !writeWorkspaceTextFile || !dirty) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      if (instructions.content !== savedInstructions) {
        const response = await writeWorkspaceTextFile(
          target.deviceId,
          joinPath(target.root, 'AGENTS.md'),
          instructions.content,
          instructions.revision
        )
        const committed = { content: response.content, revision: response.revision }
        setInstructions(committed)
        setSavedInstructions(committed.content)
      }
      if (config.content !== savedConfig) {
        if (config.revision === MISSING_WORKSPACE_FILE_REVISION && !target.codexDirectoryExists) {
          await createDeviceDirectory(target.deviceId, joinPath(target.root, '.codex'))
          setTarget(current => (current ? { ...current, codexDirectoryExists: true } : current))
        }
        const response = await writeWorkspaceTextFile(
          target.deviceId,
          joinPath(target.root, '.codex/config.toml'),
          config.content,
          config.revision
        )
        const committed = { content: response.content, revision: response.revision }
        setConfig(committed)
        setSavedConfig(committed.content)
      }
      setSaved(true)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  const toggleProjectPlugin = (plugin: InstalledPlugin) => {
    if (plugin.spec.enabled) return
    const key = installedPluginKey(plugin)
    setConfig(current => ({
      ...current,
      content: setProjectPluginEnabled(current.content, key, !projectPluginKeys.has(key)),
    }))
    setSaved(false)
  }

  return (
    <div
      className="h-full overflow-y-auto bg-surface px-5 py-6"
      data-testid="project-settings-page"
    >
      <SettingsPage>
        <button
          type="button"
          className="mb-5 flex h-11 items-center gap-2 rounded-lg px-2 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text-primary md:h-8"
          data-testid="project-settings-back-button"
          onClick={() => navigateTo('/')}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('workbench.project_settings_back')}
        </button>
        <SettingsPageHeader
          title={`${project?.name ?? ''} · ${t('workbench.project_settings_title')}`}
          description={t('workbench.project_settings_description')}
          actions={
            <button
              type="button"
              data-testid="project-settings-save-button"
              disabled={!dirty || saving || !target}
              onClick={() => void save()}
              className="flex h-11 items-center gap-2 rounded-lg bg-text-primary px-3 text-sm text-surface disabled:opacity-40 md:h-8"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : saved ? (
                <Check className="h-4 w-4" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving
                ? t('workbench.project_settings_saving')
                : t('workbench.project_settings_save')}
            </button>
          }
        />

        {loading ? (
          <div className="flex min-h-48 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
          </div>
        ) : (
          <div className="space-y-6">
            {target ? (
              <p className="rounded-lg bg-surface-secondary px-3 py-2 text-xs text-text-secondary">
                {target.root}
              </p>
            ) : null}
            {error ? (
              <p
                className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
                data-testid="project-settings-error"
              >
                {error}
              </p>
            ) : null}
            {pluginError ? (
              <p
                className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
                data-testid="project-settings-plugin-error"
              >
                {pluginError}
              </p>
            ) : null}

            <section>
              <h2 className="heading-sm text-text-primary">
                {t('workbench.project_settings_plugins_title')}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                {t('workbench.project_settings_plugins_description')}
              </p>
              <div className="mt-3 overflow-hidden rounded-xl border border-border">
                {plugins.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-text-secondary">
                    {t('workbench.project_settings_plugins_empty')}
                  </p>
                ) : (
                  plugins.map(plugin => {
                    const key = installedPluginKey(plugin)
                    const inherited = plugin.spec.enabled
                    const checked = inherited || projectPluginKeys.has(key)
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {plugin.spec.displayName}
                          </p>
                          <p className="text-xs text-text-secondary">
                            {inherited
                              ? t('workbench.project_settings_plugin_global')
                              : t('workbench.project_settings_plugin_project')}
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={checked}
                          disabled={inherited}
                          data-testid={`project-plugin-toggle-${key}`}
                          onClick={() => toggleProjectPlugin(plugin)}
                          className="flex h-11 w-11 items-center justify-center disabled:opacity-55 md:h-8"
                        >
                          <span
                            className={`relative h-6 w-10 rounded-full transition-colors ${checked ? 'bg-text-primary' : 'bg-border'}`}
                          >
                            <span
                              className={`absolute top-1 h-4 w-4 rounded-full bg-surface transition-transform ${checked ? 'translate-x-5' : 'translate-x-1'}`}
                            />
                          </span>
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
              <button
                type="button"
                data-testid="project-settings-browse-plugins-button"
                className="mt-2 flex h-11 items-center gap-2 rounded-lg px-2 text-sm text-text-secondary hover:bg-surface-secondary md:h-8"
                onClick={() => navigateTo(`/plugins?projectId=${projectId}`)}
              >
                <ExternalLink className="h-4 w-4" />
                {t('workbench.project_settings_browse_plugins')}
              </button>
            </section>

            <section>
              <div className="flex gap-1 border-b border-border">
                {(['instructions', 'config'] as const).map(item => (
                  <button
                    key={item}
                    type="button"
                    data-testid={`project-settings-tab-${item}`}
                    onClick={() => setTab(item)}
                    className={`h-11 border-b-2 px-3 text-sm md:h-9 ${tab === item ? 'border-text-primary text-text-primary' : 'border-transparent text-text-secondary'}`}
                  >
                    {item === 'instructions' ? 'AGENTS.md' : '.codex/config.toml'}
                  </button>
                ))}
              </div>
              <p className="my-3 text-sm text-text-secondary">
                {tab === 'instructions'
                  ? t('workbench.project_settings_instructions_description')
                  : t('workbench.project_settings_config_description')}
              </p>
              <textarea
                data-testid={`project-settings-editor-${tab}`}
                value={tab === 'instructions' ? instructions.content : config.content}
                onChange={event => {
                  setSaved(false)
                  if (tab === 'instructions')
                    setInstructions(current => ({ ...current, content: event.target.value }))
                  else setConfig(current => ({ ...current, content: event.target.value }))
                }}
                spellCheck={false}
                className="min-h-80 w-full resize-y rounded-xl border border-border bg-surface-secondary p-3 font-mono text-code text-text-primary outline-none focus:border-focus"
                placeholder={
                  tab === 'instructions'
                    ? t('workbench.project_settings_instructions_placeholder')
                    : '[plugins."example@marketplace"]\nenabled = true'
                }
              />
            </section>
            <p className="text-xs text-text-secondary">
              {t('workbench.project_settings_restart_hint')}
            </p>
          </div>
        )}
      </SettingsPage>
    </div>
  )
}
