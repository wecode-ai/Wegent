import {
  Brain,
  Folder,
  FolderPlus,
  LayoutDashboard,
  Loader2,
  MessageSquareText,
  Plug,
  Search,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import { shouldUseNativeProjectDirectoryPicker } from '@/e2e/automation'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import {
  loadProjectSpaceOptions,
  projectSpaceKey,
  projectSpaceRef,
  type ProjectSpaceApi,
  type ProjectSpaceOption,
} from '@/features/todo/projectSpaceSelection'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { openNativeProjectDirectoryPickers } from '@/lib/native-directory-picker'
import {
  getControlsForModel,
  getDefaultModelOptions,
  getModelDisplayLabel,
  normalizeModelOptions,
} from '@/lib/model-ui'
import type {
  DeviceInfo,
  ModelOptions,
  PluginMarketplaceItem,
  RuntimeProjectAiSettings,
  RuntimeProjectPluginRef,
  RuntimeProjectQuickPhrase,
  RuntimeProjectSpaceRef,
  RuntimeProjectWork,
  UnifiedModel,
} from '@/types/api'
import { QuickPhrasesEditor } from '../settings/QuickPhrasesEditor'
import {
  marketplacePluginLockLabel,
  resolveMarketplacePluginLock,
} from '../plugins/marketplacePluginLock'
import { DeviceFolderPicker } from './DeviceFolderPicker'

interface LocalProjectEditDialogProps {
  open: boolean
  projectWork: RuntimeProjectWork | null
  device: DeviceInfo | null
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  projectSpaceApis?: ProjectSpaceApi[]
  models?: UnifiedModel[]
  pluginApi?: Pick<
    LocalCodexPluginApi,
    'readState' | 'installAvailablePlugin' | 'updateInstalledPlugin'
  >
  onClose: () => void
  onSave: (data: {
    deviceId: string
    projectKey: string
    name: string
    roots: string[]
    defaultProjectSpace: RuntimeProjectSpaceRef | null
    aiSettings: RuntimeProjectAiSettings | null
  }) => Promise<void>
  onDelete: () => void
}

function folderName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized
}

function uniqueRoots(roots: string[]): string[] {
  return Array.from(new Set(roots.map(root => root.trim()).filter(Boolean)))
}

export function LocalProjectEditDialog({
  open,
  projectWork,
  device,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  projectSpaceApis,
  models,
  pluginApi,
  onClose,
  onSave,
  onDelete,
}: LocalProjectEditDialogProps) {
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  if (!open || !projectWork) return null
  return (
    <LocalProjectEditDialogContent
      key={projectWork.project.key}
      projectWork={projectWork}
      device={device}
      onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
      onListDeviceDirectories={onListDeviceDirectories}
      onCreateDeviceDirectory={onCreateDeviceDirectory}
      projectSpaceApis={experimentalFeaturesEnabled ? projectSpaceApis : undefined}
      models={models}
      pluginApi={pluginApi}
      onClose={onClose}
      onSave={onSave}
      onDelete={onDelete}
    />
  )
}

function LocalProjectEditDialogContent({
  projectWork,
  device,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  projectSpaceApis = [],
  models = [],
  pluginApi,
  onClose,
  onSave,
  onDelete,
}: Omit<LocalProjectEditDialogProps, 'open' | 'projectWork'> & {
  projectWork: RuntimeProjectWork
}) {
  const { t } = useTranslation('common')
  const initialRoots = useMemo(
    () =>
      uniqueRoots(
        projectWork.project.roots?.map(root => root.path) ??
          projectWork.deviceWorkspaces.map(workspace => workspace.workspacePath)
      ),
    [projectWork]
  )
  const [name, setName] = useState(projectWork.project.name)
  const [roots, setRoots] = useState(initialRoots)
  const [submitting, setSubmitting] = useState(false)
  const [activeTab, setActiveTab] = useState<'basic' | 'ai' | 'quick-phrases' | 'plugins'>('basic')
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projectSpaceOptions, setProjectSpaceOptions] = useState<ProjectSpaceOption[]>([])
  const [autoJoinProjectSpaceKey, setAutoJoinProjectSpaceKey] = useState<string | null>(() => {
    const ref = projectWork.project.defaultProjectSpace
    return ref ? projectSpaceKey(ref) : null
  })
  const [projectSpacesLoading, setProjectSpacesLoading] = useState(projectSpaceApis.length > 0)
  const initialAiSettings = projectWork.project.aiSettings
  const [instructions, setInstructions] = useState(initialAiSettings?.instructions ?? '')
  const [modelSelection, setModelSelection] = useState(initialAiSettings?.modelSelection ?? null)
  const [projectPlugins, setProjectPlugins] = useState<RuntimeProjectPluginRef[]>(
    initialAiSettings?.plugins ?? []
  )
  const [quickPhrases, setQuickPhrases] = useState<RuntimeProjectQuickPhrase[]>(
    initialAiSettings?.quickPhrases ?? []
  )
  const [pluginItems, setPluginItems] = useState<PluginMarketplaceItem[]>([])
  const [pluginSearch, setPluginSearch] = useState('')
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [installingPluginId, setInstallingPluginId] = useState<string | null>(null)
  const selectableModels = useMemo(
    () => models.filter(model => !model.compatibilityDisabled),
    [models]
  )
  const selectedModel = useMemo(
    () =>
      modelSelection
        ? (selectableModels.find(
            model =>
              model.name === modelSelection.modelName &&
              (!modelSelection.modelType || model.type === modelSelection.modelType)
          ) ?? null)
        : null,
    [modelSelection, selectableModels]
  )
  const reasoningControl = useMemo(
    () => getControlsForModel(selectedModel).find(control => control.id === 'reasoning') ?? null,
    [selectedModel]
  )
  const deviceId =
    projectWork.project.stateDeviceId?.trim() ||
    projectWork.deviceWorkspaces[0]?.deviceId.trim() ||
    ''
  useEscapeKey(onClose, !submitting)

  useEffect(() => {
    if (projectSpaceApis.length === 0) return
    let active = true
    void loadProjectSpaceOptions(projectSpaceApis)
      .then(options => {
        if (!active) return
        setProjectSpaceOptions(options)
      })
      .catch(loadError => {
        if (!active) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (active) setProjectSpacesLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectSpaceApis])

  useEffect(() => {
    if (activeTab !== 'plugins' || !pluginApi) return
    let active = true
    void pluginApi
      .readState({ mergeAllMarketplaces: true })
      .then(state => {
        if (active) setPluginItems(state.marketplaceItems)
      })
      .catch(loadError => {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (active) setPluginsLoading(false)
      })
    return () => {
      active = false
    }
  }, [activeTab, pluginApi])

  const filteredPluginItems = useMemo(() => {
    const query = pluginSearch.trim().toLowerCase()
    if (!query) return pluginItems
    return pluginItems.filter(item =>
      [item.displayName, item.name, item.description, item.sourceLabel]
        .filter((value): value is string => Boolean(value))
        .some(value => value.toLowerCase().includes(query))
    )
  }, [pluginItems, pluginSearch])

  const installProjectPlugin = async (item: PluginMarketplaceItem) => {
    if (!pluginApi || installingPluginId) return
    const installLock = resolveMarketplacePluginLock(item)
    if (installLock) {
      setError(marketplacePluginLockLabel(installLock, t))
      return
    }
    const marketplaceId =
      typeof item.manifest?.marketplaceId === 'string' ? item.manifest.marketplaceId.trim() : ''
    if (!marketplaceId) {
      setError(t('workbench.project_plugin_marketplace_missing', '插件市场信息缺失'))
      return
    }
    const projectPlugin: RuntimeProjectPluginRef = {
      id: `${item.name}@${marketplaceId}`,
      pluginName: item.name,
      marketplaceId,
      displayName: item.displayName || item.name,
    }
    setInstallingPluginId(projectPlugin.id)
    setError(null)
    try {
      if (!item.installed) {
        const installed = await pluginApi.installAvailablePlugin(item.id, marketplaceId)
        const labels =
          installed.metadata.labels && typeof installed.metadata.labels === 'object'
            ? (installed.metadata.labels as Record<string, unknown>)
            : {}
        const installedId =
          typeof labels.id === 'string' || typeof labels.id === 'number' ? labels.id : null
        if (installed.spec.enabled && installedId === null) {
          throw new Error(
            t(
              'workbench.project_plugin_installed_id_missing',
              '插件已安装，但无法将其限制在当前项目'
            )
          )
        }
        if (installed.spec.enabled && installedId !== null) {
          await pluginApi.updateInstalledPlugin(installedId, { enabled: false })
        }
      }
      setProjectPlugins(current =>
        current.some(plugin => plugin.id === projectPlugin.id)
          ? current
          : [...current, projectPlugin]
      )
      setPluginItems(current =>
        current.map(plugin =>
          plugin.id === item.id ? { ...plugin, installed: true, enabled: false } : plugin
        )
      )
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError))
    } finally {
      setInstallingPluginId(null)
    }
  }

  const addFolders = async () => {
    if (!shouldUseNativeProjectDirectoryPicker()) {
      setShowFolderPicker(true)
      return
    }
    try {
      const selected = await openNativeProjectDirectoryPickers(roots[0])
      if (selected.length > 0) setRoots(current => uniqueRoots([...current, ...selected]))
    } catch (pickerError) {
      setError(pickerError instanceof Error ? pickerError.message : String(pickerError))
    }
  }

  const save = async () => {
    const trimmedName = name.trim()
    if (!trimmedName || roots.length === 0 || !deviceId || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const selectedProjectSpace = projectSpaceOptions.find(
        option => option.key === autoJoinProjectSpaceKey
      )
      const existingDefaultProjectSpace = projectWork.project.defaultProjectSpace ?? null
      const existingDefaultKey = existingDefaultProjectSpace
        ? projectSpaceKey(existingDefaultProjectSpace)
        : null
      await onSave({
        deviceId,
        projectKey: projectWork.project.key,
        name: trimmedName,
        roots,
        defaultProjectSpace: selectedProjectSpace
          ? projectSpaceRef(selectedProjectSpace.project)
          : autoJoinProjectSpaceKey === existingDefaultKey
            ? existingDefaultProjectSpace
            : null,
        aiSettings: {
          instructions: instructions.trim(),
          modelSelection,
          ...(projectPlugins.length > 0 ? { plugins: projectPlugins } : {}),
          ...(quickPhrases.length > 0 ? { quickPhrases } : {}),
        },
      })
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-project-edit-title"
        data-testid="local-project-edit-dialog"
        className="max-h-[calc(100vh-32px)] w-full max-w-[560px] overflow-y-auto rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="local-project-edit-title" className="heading-base">
            {t('workbench.edit_project', '编辑项目')}
          </h2>
          <button
            type="button"
            data-testid="close-local-project-edit-dialog"
            onClick={onClose}
            disabled={submitting}
            aria-label={t('workbench.close_dialog', '关闭')}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 flex gap-1 border-b border-border" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'basic'}
            data-testid="local-project-settings-basic-tab"
            onClick={() => setActiveTab('basic')}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              activeTab === 'basic'
                ? 'border-text-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('workbench.project_settings_basic_tab', '基本信息')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ai'}
            data-testid="local-project-settings-ai-tab"
            onClick={() => setActiveTab('ai')}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              activeTab === 'ai'
                ? 'border-text-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('workbench.project_settings_ai_tab', 'AI 设置')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'quick-phrases'}
            data-testid="local-project-settings-quick-phrases-tab"
            onClick={() => setActiveTab('quick-phrases')}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              activeTab === 'quick-phrases'
                ? 'border-text-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('workbench.project_settings_quick_phrases_tab', '快捷短语')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'plugins'}
            data-testid="local-project-settings-plugins-tab"
            onClick={() => {
              setPluginsLoading(Boolean(pluginApi))
              setActiveTab('plugins')
            }}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              activeTab === 'plugins'
                ? 'border-text-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('workbench.project_settings_plugins_tab', '插件')}
          </button>
        </div>

        {activeTab === 'basic' ? (
          <div data-testid="local-project-settings-basic-panel">
            <label className="mt-5 flex h-11 items-center rounded-xl border border-border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10">
              <Folder className="mx-3 h-4 w-4 shrink-0 text-text-secondary" />
              <span className="h-full w-px bg-border" />
              <input
                data-testid="local-project-name-input"
                aria-label={t('workbench.project_name', '项目名称')}
                value={name}
                autoFocus
                disabled={submitting}
                onChange={event => setName(event.target.value)}
                className="min-w-0 flex-1 bg-transparent px-3 text-base outline-none"
              />
            </label>

            <h3 className="mt-5 text-base font-medium">
              {t('workbench.source_folders', '源文件夹')}
            </h3>
            <div className="mt-2 overflow-hidden rounded-xl border border-border bg-background">
              {roots.map((root, index) => (
                <div
                  key={root}
                  data-testid={`local-project-root-${index}`}
                  className="flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0"
                >
                  <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="min-w-0 flex-1 truncate text-base" title={root}>
                    {folderName(root)}
                  </span>
                  {index === 0 ? (
                    <span className="rounded-lg border border-border px-2 py-1 text-sm text-text-secondary">
                      {t('workbench.primary_folder', '主目录')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      data-testid={`make-primary-root-${index}`}
                      disabled={submitting}
                      onClick={() =>
                        setRoots(current => [root, ...current.filter(item => item !== root)])
                      }
                      className="rounded-lg bg-muted px-2 py-1 text-sm hover:bg-border"
                    >
                      {t('workbench.make_primary_folder', '设为主目录')}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`remove-local-project-root-${index}`}
                    disabled={submitting || roots.length === 1}
                    onClick={() => setRoots(current => current.filter(item => item !== root))}
                    aria-label={t('workbench.remove_source_folder', { name: folderName(root) })}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-30"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                data-testid="add-local-project-folders"
                disabled={submitting}
                onClick={() => void addFolders()}
                className="flex h-11 w-full items-center gap-3 px-3 text-left text-base hover:bg-muted disabled:opacity-50"
              >
                <FolderPlus className="h-4 w-4 text-text-secondary" />
                {t('workbench.add_folder', '添加文件夹')}
              </button>
              {showFolderPicker && device && (
                <div
                  className="border-t border-border p-3"
                  data-testid="local-project-folder-picker"
                >
                  <DeviceFolderPicker
                    device={device}
                    mode="select"
                    initialPath={roots[0]}
                    confirmLabel={t('workbench.add_folder', '添加文件夹')}
                    onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
                    onListDeviceDirectories={onListDeviceDirectories}
                    onCreateDeviceDirectory={onCreateDeviceDirectory}
                    onConfirm={({ path }) => {
                      setRoots(current => uniqueRoots([...current, path]))
                      setShowFolderPicker(false)
                    }}
                    onCancel={() => setShowFolderPicker(false)}
                  />
                </div>
              )}
            </div>

            {projectSpaceApis.length > 0 && (
              <>
                <h3 className="mt-5 text-base font-medium">
                  {t('workbench.project_auto_join_space', '自动加入项目空间')}
                </h3>
                <p className="mt-1 text-sm text-text-secondary">
                  {t(
                    'workbench.project_auto_join_space_description',
                    '在这个项目里开启的新对话会默认加入所选项目空间，并在发送前明确显示。'
                  )}
                </p>
                <label className="mt-2 flex h-11 items-center rounded-xl border border-border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10">
                  <LayoutDashboard className="mx-3 h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="h-full w-px bg-border" />
                  <select
                    data-testid="local-project-auto-join-space-select"
                    aria-label={t('workbench.project_auto_join_space', '自动加入项目空间')}
                    value={autoJoinProjectSpaceKey ?? ''}
                    disabled={submitting || projectSpacesLoading}
                    onChange={event => setAutoJoinProjectSpaceKey(event.target.value || null)}
                    className="min-w-0 flex-1 bg-transparent px-3 text-base outline-none"
                  >
                    <option value="">
                      {projectSpacesLoading
                        ? t('workbench.loading', '加载中...')
                        : t('workbench.project_auto_join_space_none', '不自动加入')}
                    </option>
                    {projectSpaceOptions.map(option => (
                      <option key={option.key} value={option.key}>
                        {option.project.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
        ) : activeTab === 'ai' ? (
          <div data-testid="local-project-settings-ai-panel">
            <p className="mt-5 text-sm text-text-secondary">
              {t(
                'workbench.project_ai_settings_description',
                '这些设置仅对新建对话生效，已有对话不受影响。'
              )}
            </p>
            <label className="mt-4 block text-sm font-medium" htmlFor="local-project-instructions">
              {t('workbench.project_instructions', '项目指令')}
            </label>
            <textarea
              id="local-project-instructions"
              data-testid="local-project-instructions-input"
              value={instructions}
              disabled={submitting}
              onChange={event => setInstructions(event.target.value)}
              placeholder={t('workbench.project_instructions_placeholder', '留空则只使用全局指令')}
              className="mt-2 min-h-28 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50"
            />
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                'workbench.project_instructions_description',
                '全局 Codex 指令仍然生效，项目指令会追加在其后。'
              )}
            </p>

            <label className="mt-5 block text-sm font-medium" htmlFor="local-project-model">
              {t('workbench.project_default_model', '默认模型')}
            </label>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(120px,160px)] gap-2">
              <label className="flex h-11 items-center rounded-xl border border-border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10">
                <Brain className="mx-3 h-4 w-4 shrink-0 text-text-secondary" />
                <span className="h-full w-px bg-border" />
                <select
                  id="local-project-model"
                  data-testid="local-project-model-select"
                  value={selectedModel ? `${selectedModel.type}:${selectedModel.name}` : ''}
                  disabled={submitting}
                  onChange={event => {
                    const model = selectableModels.find(
                      candidate => `${candidate.type}:${candidate.name}` === event.target.value
                    )
                    setModelSelection(
                      model
                        ? {
                            modelName: model.name,
                            modelType: model.type,
                            options: getDefaultModelOptions(model),
                          }
                        : null
                    )
                  }}
                  className="min-w-0 flex-1 bg-transparent px-3 text-base outline-none"
                >
                  <option value="">
                    {t('workbench.project_default_model_inherit', '跟随全局')}
                  </option>
                  {selectableModels.map(model => (
                    <option
                      key={`${model.type}:${model.name}`}
                      value={`${model.type}:${model.name}`}
                    >
                      {getModelDisplayLabel(model)}
                    </option>
                  ))}
                </select>
              </label>
              <select
                data-testid="local-project-reasoning-select"
                aria-label={t('workbench.reasoning_level', '推理强度')}
                value={modelSelection?.options?.reasoning ?? reasoningControl?.defaultValue ?? ''}
                disabled={submitting || !selectedModel || !reasoningControl}
                onChange={event => {
                  if (!selectedModel || !modelSelection) return
                  const options: ModelOptions = normalizeModelOptions(selectedModel, {
                    ...modelSelection.options,
                    reasoning: event.target.value,
                  })
                  setModelSelection({ ...modelSelection, options })
                }}
                className="h-11 min-w-0 rounded-xl border border-border bg-background px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50"
              >
                {!reasoningControl ? (
                  <option value="">
                    {t('workbench.project_default_reasoning_inherit', '全局推理设置')}
                  </option>
                ) : (
                  reasoningControl.options.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.labelKey ? t(option.labelKey, option.label) : option.label}
                    </option>
                  ))
                )}
              </select>
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              {modelSelection
                ? t(
                    'workbench.project_default_model_description',
                    '新对话默认使用项目模型，Composer 中仍可为单次对话临时切换。'
                  )
                : t(
                    'workbench.project_default_model_inherit_description',
                    '新对话跟随全局默认模型；全局设置变化后自动生效。'
                  )}
            </p>
          </div>
        ) : activeTab === 'quick-phrases' ? (
          <div data-testid="local-project-settings-quick-phrases-panel">
            <div className="mb-4 mt-5 flex items-start gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
              <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
              <div>
                <p className="text-sm font-medium">
                  {t('workbench.project_quick_phrases_title', '项目快捷短语')}
                </p>
                <p className="mt-0.5 text-sm text-text-secondary">
                  {t(
                    'workbench.project_quick_phrases_description',
                    '仅在这个项目的输入框中显示，并排在设备全局快捷短语之前。'
                  )}
                </p>
              </div>
            </div>
            <QuickPhrasesEditor
              phrases={quickPhrases}
              disabled={submitting}
              testIdPrefix="local-project-"
              onChange={next => setQuickPhrases(next)}
            />
          </div>
        ) : (
          <div data-testid="local-project-settings-plugins-panel">
            <p className="mt-5 text-sm text-text-secondary">
              {t(
                'workbench.project_plugins_description',
                '安装到此项目的插件只会在该项目的新对话中加载。插件包缓存可复用，但不会自动出现在其他项目。'
              )}
            </p>
            <label className="mt-4 flex h-10 items-center rounded-xl border border-border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10">
              <Search className="mx-3 h-4 w-4 shrink-0 text-text-secondary" />
              <input
                data-testid="local-project-plugin-search"
                value={pluginSearch}
                disabled={submitting || pluginsLoading}
                onChange={event => setPluginSearch(event.target.value)}
                placeholder={t('workbench.project_plugins_search_placeholder', '搜索插件市场')}
                className="min-w-0 flex-1 bg-transparent pr-3 text-base outline-none"
              />
            </label>
            <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-border bg-background">
              {pluginsLoading ? (
                <div className="flex h-20 items-center justify-center gap-2 text-sm text-text-secondary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('workbench.loading', '加载中...')}
                </div>
              ) : filteredPluginItems.length > 0 ? (
                filteredPluginItems.map(item => {
                  const marketplaceId =
                    typeof item.manifest?.marketplaceId === 'string'
                      ? item.manifest.marketplaceId
                      : ''
                  const projectPluginId = `${item.name}@${marketplaceId}`
                  const installedForProject = projectPlugins.some(
                    plugin => plugin.id === projectPluginId
                  )
                  const installing = installingPluginId === projectPluginId
                  const installLock = installedForProject
                    ? null
                    : resolveMarketplacePluginLock(item)
                  return (
                    <div
                      key={`${marketplaceId}:${item.id}`}
                      data-testid={`local-project-plugin-row-${item.name}`}
                      className="flex min-h-14 items-center gap-3 border-b border-border px-3 last:border-b-0"
                    >
                      <Plug className="h-4 w-4 shrink-0 text-text-secondary" />
                      <div className="min-w-0 flex-1 py-2">
                        <div className="truncate text-base">{item.displayName || item.name}</div>
                        <div className="truncate text-sm text-text-secondary">
                          {item.sourceLabel || marketplaceId}
                        </div>
                      </div>
                      <button
                        type="button"
                        data-testid={`local-project-plugin-toggle-${item.name}`}
                        disabled={
                          submitting || installing || !marketplaceId || Boolean(installLock)
                        }
                        onClick={() => {
                          if (installedForProject) {
                            setProjectPlugins(current =>
                              current.filter(plugin => plugin.id !== projectPluginId)
                            )
                            return
                          }
                          void installProjectPlugin(item)
                        }}
                        className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm hover:bg-border disabled:opacity-50"
                      >
                        {installing && <Loader2 className="h-4 w-4 animate-spin" />}
                        {installedForProject
                          ? t('workbench.project_plugin_remove', '移出项目')
                          : installLock
                            ? marketplacePluginLockLabel(installLock, t)
                            : t('workbench.project_plugin_install', '安装到项目')}
                      </button>
                    </div>
                  )
                })
              ) : (
                <div className="flex h-20 items-center justify-center text-sm text-text-secondary">
                  {pluginApi
                    ? t('workbench.project_plugins_empty', '没有匹配的插件')
                    : t('workbench.project_plugins_unavailable', '插件市场当前不可用')}
                </div>
              )}
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            data-testid="delete-local-project-button"
            disabled={submitting}
            onClick={onDelete}
            className="h-9 rounded-lg bg-red-500/10 px-3 text-sm font-medium text-red-500 hover:bg-red-500/15 disabled:opacity-50"
          >
            {t('workbench.delete_project', '删除项目')}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="cancel-local-project-edit-button"
            disabled={submitting}
            onClick={onClose}
            className="h-9 rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="save-local-project-button"
            disabled={
              submitting || projectSpacesLoading || !name.trim() || roots.length === 0 || !deviceId
            }
            onClick={() => void save()}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('workbench.save', '保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
