import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ExternalLink, Loader2, Plus, Save } from 'lucide-react'
import {
  createLocalCodexPluginApi,
  type LocalCodexMarketplace,
  type LocalCodexPluginsState,
} from '@/api/local/codexPlugins'
import { SettingsPage, SettingsPageHeader } from '@/components/settings/settings-ui'
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
import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'

type ConfigTab = 'instructions' | 'config'

interface EditableFile {
  content: string
  revision: string
}

const EMPTY_FILE: EditableFile = { content: '', revision: MISSING_WORKSPACE_FILE_REVISION }

function joinPath(root: string, child: string): string {
  return `${root.replace(/[\\/]$/, '')}/${child}`
}

function installedPluginKey(plugin: InstalledPlugin): string {
  const { pluginKey, providerKey } = plugin.spec.source
  return pluginKey.includes('@') ? pluginKey : `${pluginKey}@${providerKey}`
}

function installedPluginId(plugin: InstalledPlugin): string | number | null {
  const labels = plugin.metadata.labels
  if (!labels || typeof labels !== 'object') return null
  const id = (labels as Record<string, unknown>).id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

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
  const [availablePlugins, setAvailablePlugins] = useState<PluginMarketplaceItem[]>([])
  const [marketplaces, setMarketplaces] = useState<LocalCodexMarketplace[]>([])
  const [selectedMarketplaceId, setSelectedMarketplaceId] = useState('')
  const [marketplaceSource, setMarketplaceSource] = useState('')
  const [addingMarketplace, setAddingMarketplace] = useState(false)
  const [installingPluginId, setInstallingPluginId] = useState<string | number | null>(null)
  const [tab, setTab] = useState<ConfigTab>('instructions')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = instructions.content !== savedInstructions || config.content !== savedConfig
  const projectPluginKeys = useMemo(
    () => enabledProjectPluginKeys(config.content),
    [config.content]
  )

  const applyPluginState = useCallback((pluginState: LocalCodexPluginsState) => {
    setPlugins(pluginState.installedPlugins)
    setAvailablePlugins(pluginState.marketplaceItems.filter(item => !item.installed))
    setMarketplaces(pluginState.marketplaces)
    setSelectedMarketplaceId(pluginState.selectedMarketplaceId)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const context = loadContextRef.current
      setError(null)
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
        const [nextInstructions, nextConfig, pluginState] = await Promise.all([
          loadOptionalFile(root, 'AGENTS.md'),
          hasCodexDirectory
            ? loadOptionalFile(codexDirectory, 'config.toml')
            : Promise.resolve(EMPTY_FILE),
          pluginApi?.readState() ?? Promise.resolve(null),
        ])
        if (cancelled) return
        setTarget({ deviceId, root, codexDirectoryExists: hasCodexDirectory })
        setInstructions(nextInstructions)
        setConfig(nextConfig)
        setSavedInstructions(nextInstructions.content)
        setSavedConfig(nextConfig.content)
        if (pluginState) applyPluginState(pluginState)
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
      let nextInstructions = instructions
      let nextConfig = config
      if (instructions.content !== savedInstructions) {
        const response = await writeWorkspaceTextFile(
          target.deviceId,
          joinPath(target.root, 'AGENTS.md'),
          instructions.content,
          instructions.revision
        )
        nextInstructions = { content: response.content, revision: response.revision }
      }
      if (config.content !== savedConfig) {
        if (config.revision === MISSING_WORKSPACE_FILE_REVISION && !target.codexDirectoryExists) {
          await createDeviceDirectory(target.deviceId, joinPath(target.root, '.codex'))
        }
        const response = await writeWorkspaceTextFile(
          target.deviceId,
          joinPath(target.root, '.codex/config.toml'),
          config.content,
          config.revision
        )
        nextConfig = { content: response.content, revision: response.revision }
      }
      setInstructions(nextInstructions)
      setConfig(nextConfig)
      setSavedInstructions(nextInstructions.content)
      setSavedConfig(nextConfig.content)
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

  const installPluginForProject = async (item: PluginMarketplaceItem) => {
    setInstallingPluginId(item.id)
    setError(null)
    try {
      const pluginApi = createLocalCodexPluginApi()
      if (selectedMarketplaceId) await pluginApi.selectMarketplace(selectedMarketplaceId)
      const installed = await pluginApi.installAvailablePlugin(item.id)
      const id = installedPluginId(installed)
      if (id != null) await pluginApi.updateInstalledPlugin(id, { enabled: false })
      const key = installedPluginKey(installed)
      setPlugins(current => [
        ...current.filter(plugin => installedPluginKey(plugin) !== key),
        { ...installed, spec: { ...installed.spec, enabled: false } },
      ])
      setAvailablePlugins(current => current.filter(plugin => plugin.id !== item.id))
      setConfig(current => ({
        ...current,
        content: setProjectPluginEnabled(current.content, key, true),
      }))
      setSaved(false)
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError))
    } finally {
      setInstallingPluginId(null)
    }
  }

  const addMarketplace = async () => {
    const source = marketplaceSource.trim()
    if (!source) return
    setAddingMarketplace(true)
    setError(null)
    try {
      const pluginState = await createLocalCodexPluginApi().upsertMarketplace({ path: source })
      applyPluginState(pluginState)
      setMarketplaceSource('')
    } catch (marketplaceError) {
      setError(
        marketplaceError instanceof Error ? marketplaceError.message : String(marketplaceError)
      )
    } finally {
      setAddingMarketplace(false)
    }
  }

  const selectMarketplace = async (marketplaceId: string) => {
    setSelectedMarketplaceId(marketplaceId)
    setError(null)
    try {
      applyPluginState(await createLocalCodexPluginApi().selectMarketplace(marketplaceId))
    } catch (marketplaceError) {
      setError(
        marketplaceError instanceof Error ? marketplaceError.message : String(marketplaceError)
      )
    }
  }

  return (
    <div
      className="h-full overflow-y-auto bg-surface px-5 py-6"
      data-testid="project-settings-page"
    >
      <SettingsPage>
        <button
          type="button"
          className="mb-5 flex h-8 items-center gap-2 rounded-lg px-2 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
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
              className="flex h-8 items-center gap-2 rounded-lg bg-text-primary px-3 text-sm text-surface disabled:opacity-40"
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
                          className={`relative h-6 w-10 rounded-full transition-colors ${checked ? 'bg-text-primary' : 'bg-border'} disabled:opacity-55`}
                        >
                          <span
                            className={`absolute top-1 h-4 w-4 rounded-full bg-surface transition-transform ${checked ? 'translate-x-5' : 'translate-x-1'}`}
                          />
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
              <div className="mt-4" data-testid="project-plugin-catalog">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-text-primary">
                    {t('workbench.project_settings_available_plugins')}
                  </h3>
                  {marketplaces.length > 0 ? (
                    <select
                      value={selectedMarketplaceId}
                      data-testid="project-plugin-marketplace-select"
                      aria-label={t('workbench.project_settings_marketplace_label')}
                      onChange={event => void selectMarketplace(event.target.value)}
                      className="h-11 max-w-64 rounded-lg border border-border bg-surface px-2 text-sm text-text-primary outline-none focus:border-focus md:h-8"
                    >
                      {marketplaces.map(marketplace => (
                        <option key={marketplace.id} value={marketplace.id}>
                          {marketplace.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
                {marketplaces.length === 0 ? (
                  <div className="mt-2 rounded-xl border border-border p-4">
                    <p className="text-sm text-text-secondary">
                      {t('workbench.project_settings_marketplace_empty')}
                    </p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        value={marketplaceSource}
                        data-testid="project-plugin-marketplace-source"
                        aria-label={t('workbench.project_settings_marketplace_source')}
                        placeholder={t('workbench.project_settings_marketplace_placeholder')}
                        onChange={event => setMarketplaceSource(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void addMarketplace()
                        }}
                        className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface-secondary px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-focus md:h-9"
                      />
                      <button
                        type="button"
                        data-testid="project-plugin-add-marketplace"
                        disabled={!marketplaceSource.trim() || addingMarketplace}
                        onClick={() => void addMarketplace()}
                        className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-surface-secondary disabled:opacity-40 md:h-9"
                      >
                        {addingMarketplace ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                        {t('workbench.project_settings_add_marketplace')}
                      </button>
                    </div>
                  </div>
                ) : availablePlugins.length > 0 ? (
                  <div className="mt-2 overflow-hidden rounded-xl border border-border">
                    {availablePlugins.map(plugin => (
                      <div
                        key={plugin.id}
                        className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {plugin.displayName}
                          </p>
                          <p className="truncate text-xs text-text-secondary">
                            {plugin.description}
                          </p>
                        </div>
                        <button
                          type="button"
                          data-testid={`project-plugin-install-${plugin.id}`}
                          disabled={installingPluginId != null}
                          onClick={() => void installPluginForProject(plugin)}
                          className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-surface-secondary disabled:opacity-40"
                        >
                          {installingPluginId === plugin.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : null}
                          {t('workbench.project_settings_install_plugin')}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 rounded-xl border border-border px-4 py-4 text-sm text-text-secondary">
                    {t('workbench.project_settings_no_available_plugins')}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="mt-2 flex h-8 items-center gap-2 rounded-lg px-2 text-sm text-text-secondary hover:bg-surface-secondary"
                onClick={() => navigateTo('/plugins')}
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
                    className={`h-9 border-b-2 px-3 text-sm ${tab === item ? 'border-text-primary text-text-primary' : 'border-transparent text-text-secondary'}`}
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
