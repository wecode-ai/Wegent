import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import JSZip from 'jszip'
import {
  Box,
  Boxes,
  CalendarDays,
  CheckCircle2,
  CirclePlus,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Globe2,
  Loader2,
  LockKeyhole,
  PackageCheck,
  PackageOpen,
  Play,
  Puzzle,
  Search,
  Settings2,
  Share2,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  Users,
  Wrench,
  X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type {
  SmartAppAccess,
  SmartAppAccessTarget,
  SmartAppMarketplaceItem,
  SmartAppMarketplaceTag,
  SmartAppsApi,
} from '@/api/smartApps'
import { ApiError } from '@/api/http'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  harnessAppsApi,
  type HarnessAppInstallation,
  type HarnessAppManifest,
  type HarnessAppPreview,
} from '@/api/local/harnessApps'
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { SmartAppsSectionNav } from '@/components/smart-apps/SmartAppsSectionNav'
import { ApplicationContextToolbar } from '@/components/sites/ApplicationContextToolbar'
import { Button } from '@/components/ui/button'
import { HarnessAppInstallDialog } from '@/features/harness-apps/HarnessAppInstallDialog'
import {
  SmartAppDevelopmentDialog,
  type SmartAppDevelopmentInput,
} from '@/features/harness-apps/SmartAppDevelopmentDialog'
import { SmartAppPluginDialog } from '@/features/harness-apps/SmartAppPluginDialog'
import {
  HARNESS_APP_INSTALLATIONS_CHANGED_EVENT,
  notifyHarnessAppInstallationsChanged,
  type HarnessAppInstallationsChangedDetail,
} from '@/features/harness-apps/harnessAppInstallationsChanged'
import { queueSmartAppDevelopmentPreview } from '@/features/harness-apps/smartAppDevelopmentPreview'
import { useHarnessAppManagement } from '@/features/harness-apps/useHarnessAppManagement'
import { queuePluginReferenceTrial } from '@/features/plugins/pluginTrial'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { getLocalExecutorDeviceId, revealLocalFile } from '@/lib/local-terminal'
import { navigateTo } from '@/lib/navigation'
import { fileUrlToPath } from '@/lib/workspace-path-transfer'
import { ensureBundledPluginInstalled } from '@/desktop/localExecutor'

interface SmartAppsMarketplacePageProps {
  api: SmartAppsApi | null
  mode?: 'marketplace' | 'owned'
  onNavigate?: (path: string) => void
}

interface PendingInstall {
  item: SmartAppMarketplaceItem
  preview: HarnessAppPreview
}

type OwnedFilter = 'all' | 'created' | 'installed'
type MarketplaceSort = 'recommended' | 'updated'

interface OwnedSmartAppCard {
  category: Exclude<OwnedFilter, 'all'>
  installation: HarnessAppInstallation | null
  item: SmartAppMarketplaceItem | null
  key: string
}

// Keep successful local removals authoritative across route remounts. A new install
// of the same package clears the marker below.
const locallyRemovedInstallationIds = new Set<string>()

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatUpdatedAt(value: string, language: string): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return ''
  const elapsed = timestamp - Date.now()
  const absoluteElapsed = Math.abs(elapsed)
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (absoluteElapsed < 60 * 60 * 1000) {
    return formatter.format(Math.round(elapsed / (60 * 1000)), 'minute')
  }
  if (absoluteElapsed < 24 * 60 * 60 * 1000) {
    return formatter.format(Math.round(elapsed / (60 * 60 * 1000)), 'hour')
  }
  return formatter.format(Math.round(elapsed / (24 * 60 * 60 * 1000)), 'day')
}

function smartAppErrorMessage(error: unknown, fallback: string, storageUnavailable: string) {
  if (error instanceof ApiError && error.errorCode === 'smart_app_storage_unavailable') {
    return storageUnavailable
  }
  return getErrorMessage(error, fallback)
}

function SmartAppFilePicker({
  accept,
  files,
  inputTestId,
  label,
  multiple = false,
  onChange,
}: {
  accept: string
  files: File[]
  inputTestId: string
  label: string
  multiple?: boolean
  onChange: (files: File[]) => void
}) {
  const { t } = useTranslation('common')
  const inputRef = useRef<HTMLInputElement>(null)
  const selectionText =
    files.length === 0
      ? t('workbench.smart_apps_no_file_selected', '未选择文件')
      : files.length === 1
        ? files[0].name
        : t('workbench.smart_apps_files_selected', '已选择 {{count}} 个文件').replace(
            '{{count}}',
            String(files.length)
          )

  return (
    <div className="mt-2 flex min-w-0 items-center gap-3">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-11 shrink-0 md:h-9"
        data-testid={`${inputTestId}-trigger`}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-4 w-4" />
        {t('workbench.smart_apps_choose_file', '选择文件')}
      </Button>
      <span
        className="min-w-0 break-all text-sm font-normal text-text-secondary"
        data-testid={`${inputTestId}-selection`}
      >
        {selectionText}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        aria-label={label}
        data-testid={inputTestId}
        className="sr-only"
        onChange={event => {
          onChange(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
    </div>
  )
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })
}

async function readManifest(
  file: File,
  messages: { missingManifest: string; invalidPackage: string }
): Promise<HarnessAppManifest> {
  const archive = await JSZip.loadAsync(file)
  const candidates = Object.values(archive.files).filter(entry => {
    const parts = entry.name.split('/').filter(Boolean)
    return !entry.dir && parts.at(-1) === 'plugin-manifest.json' && parts.length <= 2
  })
  if (candidates.length !== 1) throw new Error(messages.missingManifest)
  const manifest = JSON.parse(await candidates[0].async('string')) as HarnessAppManifest
  if (manifest.type !== 'deepseek-harness-plugin-bundle') {
    throw new Error(messages.invalidPackage)
  }
  return manifest
}

export function SmartAppsMarketplacePage({
  api,
  mode = 'marketplace',
  onNavigate = navigateTo,
}: SmartAppsMarketplacePageProps) {
  const { t, i18n } = useTranslation('common')
  const [items, setItems] = useState<SmartAppMarketplaceItem[]>([])
  const [marketItems, setMarketItems] = useState<SmartAppMarketplaceItem[]>([])
  const [installed, setInstalled] = useState<HarnessAppInstallation[]>([])
  const [removedInstallationIds, setRemovedInstallationIds] = useState<Set<string>>(() => new Set())
  const [tags, setTags] = useState<SmartAppMarketplaceTag[]>([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'official' | 'public' | 'shared'>('all')
  const [tag, setTag] = useState('')
  const [marketplaceSort, setMarketplaceSort] = useState<MarketplaceSort>('recommended')
  const [ownedFilter, setOwnedFilter] = useState<OwnedFilter>('all')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  const [accessNotice, setAccessNotice] = useState<{
    message: string
    showMarketplace: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<SmartAppMarketplaceItem | null>(null)
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(null)
  const [modelKey, setModelKey] = useState('')
  const [publishItem, setPublishItem] = useState<SmartAppMarketplaceItem | null | undefined>()
  const [publishInstallation, setPublishInstallation] = useState<HarnessAppInstallation | null>(
    null
  )
  const [publishRequestHandled, setPublishRequestHandled] = useState(false)
  const [shareItem, setShareItem] = useState<SmartAppMarketplaceItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [developmentDialog, setDevelopmentDialog] = useState<'create' | 'copy' | null>(null)
  const [copyInstallation, setCopyInstallation] = useState<HarnessAppInstallation | null>(null)
  const [importing, setImporting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<HarnessAppInstallation | null>(null)
  const [pluginInstallation, setPluginInstallation] = useState<HarnessAppInstallation | null>(null)
  const refreshRequestRef = useRef(0)
  const activeModeRef = useRef(mode)

  useLayoutEffect(() => {
    activeModeRef.current = mode
  }, [mode])

  const navigateFromSmartApps = useCallback(
    (path: string) => {
      setAccessNotice(null)
      onNavigate(path)
    },
    [onNavigate]
  )

  const refresh = useCallback(async () => {
    if (activeModeRef.current !== mode) return
    const requestId = ++refreshRequestRef.current
    const isCurrentRequest = () =>
      requestId === refreshRequestRef.current && activeModeRef.current === mode
    setLoading(true)
    setError(null)
    try {
      const localPromise = harnessAppsApi.list().catch(() => [])
      const local = await localPromise
      if (!isCurrentRequest()) return
      setInstalled(local)
      if (!api) {
        setItems([])
        setMarketItems([])
        return
      }
      const [catalog, marketplace, tagCatalog] = await Promise.all([
        mode === 'owned'
          ? api.listOwned()
          : api.listMarketplace({
              q: query,
              source: source === 'all' ? undefined : source,
              tag: tag || undefined,
            }),
        mode === 'owned' ? api.listMarketplace() : null,
        api.listTags().catch(() => ({ version: 0, items: [] })),
      ])
      if (!isCurrentRequest()) return
      setItems(catalog.items)
      setMarketItems(marketplace?.items ?? catalog.items)
      setTags(tagCatalog.items.filter(item => item.enabled).sort((a, b) => a.sort - b.sort))
    } catch (loadError) {
      if (!isCurrentRequest()) return
      setError(
        smartAppErrorMessage(
          loadError,
          t('workbench.smart_apps_marketplace_load_failed', '智能工作台市场加载失败'),
          t('workbench.smart_apps_storage_unavailable', '文件存储服务暂不可用，请稍后重试')
        )
      )
    } finally {
      if (isCurrentRequest()) setLoading(false)
    }
  }, [api, mode, query, source, t, tag])

  const activeInstallations = useMemo(
    () =>
      installed.filter(
        item => !removedInstallationIds.has(item.id) && !locallyRemovedInstallationIds.has(item.id)
      ),
    [installed, removedInstallationIds]
  )
  const {
    changeModel,
    hasSelectedModel,
    modelOptions,
    open: openInstalledApp,
    start: startInstalledApp,
    stop: stopInstalledApp,
  } = useHarnessAppManagement({
    installations: activeInstallations,
    onBusyChange: setBusy,
    onError: setError,
    onRefresh: refresh,
  })
  const installModelKey = modelKey || modelOptions[0]?.key || ''
  const ownedCards = useMemo<OwnedSmartAppCard[]>(() => {
    return activeInstallations.map(installation => {
      const ownedItem = items.find(
        item => item.id === installation.smartAppId || item.name === installation.manifest.name
      )
      const marketItem = installation.smartAppId
        ? marketItems.find(item => item.id === installation.smartAppId)
        : null
      return {
        category: (ownedItem || !installation.smartAppId
          ? 'created'
          : 'installed') as OwnedSmartAppCard['category'],
        installation,
        item: ownedItem ?? marketItem ?? null,
        key: `local-${installation.id}`,
      }
    })
  }, [activeInstallations, items, marketItems])
  const visibleOwnedCards = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return ownedCards.filter(card => {
      if (ownedFilter !== 'all' && card.category !== ownedFilter) return false
      if (!normalizedQuery) return true
      const title = card.item?.displayName ?? card.installation?.manifest.displayName ?? ''
      const description = card.item?.summary ?? card.installation?.manifest.description ?? ''
      return `${title} ${description}`.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [ownedCards, ownedFilter, query])
  const visibleMarketplaceItems = useMemo(
    () =>
      marketplaceSort === 'updated'
        ? [...items].sort(
            (left, right) =>
              new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
          )
        : items,
    [items, marketplaceSort]
  )
  const hasItems = mode === 'owned' ? visibleOwnedCards.length > 0 : items.length > 0

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), query ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [refresh, query])

  useEffect(() => {
    const refreshWhenReenteringSmartApps = () => {
      const params = new URLSearchParams(window.location.search)
      if (window.location.pathname !== '/sites' || params.get('app_type') !== 'smart_app') return
      void refresh()
    }
    window.addEventListener('popstate', refreshWhenReenteringSmartApps)
    return () => window.removeEventListener('popstate', refreshWhenReenteringSmartApps)
  }, [refresh])

  useEffect(() => {
    const syncLocalInstallationChange = (event: Event) => {
      const detail = (event as CustomEvent<HarnessAppInstallationsChangedDetail>).detail
      if (detail.type === 'removed') {
        locallyRemovedInstallationIds.add(detail.installationId)
        setRemovedInstallationIds(current => new Set(current).add(detail.installationId))
        setInstalled(current => current.filter(item => item.id !== detail.installationId))
        return
      }
      if (detail.type === 'stopped') {
        setInstalled(current =>
          current.map(item =>
            item.id === detail.installationId
              ? { ...item, state: 'installed', webUrl: null, error: null }
              : item
          )
        )
        return
      }

      locallyRemovedInstallationIds.delete(detail.installationId)
      setRemovedInstallationIds(current => {
        const next = new Set(current)
        next.delete(detail.installationId)
        return next
      })
      setInstalled(current => [
        ...current.filter(item => item.id !== detail.installationId),
        detail.installation,
      ])
    }
    window.addEventListener(HARNESS_APP_INSTALLATIONS_CHANGED_EVENT, syncLocalInstallationChange)
    return () =>
      window.removeEventListener(
        HARNESS_APP_INSTALLATIONS_CHANGED_EVENT,
        syncLocalInstallationChange
      )
  }, [])

  useEffect(() => {
    if (mode !== 'owned' || publishRequestHandled) return
    const params = new URLSearchParams(window.location.search)
    const installationId = params.get('installationId')
    if (params.get('action') !== 'publish' || !installationId) return
    const installation = activeInstallations.find(item => item.id === installationId)
    if (!installation) return
    queueMicrotask(() => {
      setPublishRequestHandled(true)
      setPublishInstallation(installation)
      setPublishItem(
        installation.smartAppId
          ? (items.find(item => item.id === installation.smartAppId) ?? null)
          : null
      )
    })
  }, [activeInstallations, items, mode, publishRequestHandled])

  function localState(item: SmartAppMarketplaceItem) {
    const installation = activeInstallations.find(candidate => candidate.smartAppId === item.id)
    if (!installation) return null
    return {
      installation,
      update: installation.releaseId !== item.latestReleaseId,
    }
  }

  async function download(item: SmartAppMarketplaceItem) {
    if (!api) return
    setBusy(`download-${item.id}`)
    setError(null)
    try {
      const descriptor = await api.getDownload(item.id)
      const preview = await harnessAppsApi.download(descriptor)
      setPendingInstall({ item, preview })
      setModelKey(localState(item)?.installation.modelKey ?? '')
      setSelected(null)
    } catch (downloadError) {
      setError(
        smartAppErrorMessage(
          downloadError,
          t('workbench.smart_apps_download_failed', '智能工作台下载失败'),
          t('workbench.smart_apps_storage_unavailable', '文件存储服务暂不可用，请稍后重试')
        )
      )
    } finally {
      setBusy(null)
    }
  }

  async function install() {
    if (!pendingInstall || !installModelKey) return
    const current = localState(pendingInstall.item)?.installation
    if (current?.state === 'running') {
      const shouldStop = window.confirm(
        t('workbench.smart_apps_update_stop_confirm', '更新需要先停止正在运行的工作台，是否继续？')
      )
      if (!shouldStop || !(await stopInstalledApp(current, false))) return
    }
    setBusy('install')
    setError(null)
    try {
      const installation = await harnessAppsApi.install(pendingInstall.preview, installModelKey, {
        smartAppId: pendingInstall.item.id,
        releaseId: pendingInstall.item.latestReleaseId,
      })
      notifyHarnessAppInstallationsChanged({
        type: 'installed',
        installationId: installation.id,
        installation,
      })
      setPendingInstall(null)
      setModelKey('')
      await refresh()
    } catch (installError) {
      setError(
        getErrorMessage(
          installError,
          t('workbench.smart_apps_install_failed_keep_old', '智能工作台安装失败，原版本已保留')
        )
      )
    } finally {
      setBusy(null)
    }
  }

  async function openBuilder(
    installation: HarnessAppInstallation,
    intent: 'develop' | 'created',
    targetWorkspace?: { deviceId: string; path: string }
  ) {
    setCreateError(null)
    try {
      const intentPrompt =
        intent === 'created'
          ? t(
              'workbench.smart_apps_builder_intent_created',
              '这是刚从 Web 预设创建的空白工作台，请先检查脚手架，再根据我的需求继续开发。'
            )
          : t(
              'workbench.smart_apps_builder_intent_develop',
              '请在现有工作台上继续增量开发；先读取已有 manifest、依赖和 cordis.patch.yml。'
            )
      await ensureBundledPluginInstalled('smart-app-builder')
      const queued = queuePluginReferenceTrial({
        pluginName: 'smart-app-builder',
        marketplaceName: 'wework-personal',
        displayName: t('workbench.smart_apps_builder_name', '智能工作台开发助手'),
        prompt: [
          `${t('workbench.smart_apps_builder_directory_prefix', '智能工作台目录：')}${installation.packagePath}`,
          intentPrompt,
          t(
            'workbench.smart_apps_builder_completion',
            '完成后运行验证；需要分发时导出 ZIP，日常开发继续直接使用此目录。'
          ),
        ].join('\n'),
        openInNewChat: true,
        targetWorkspace,
      })
      if (!queued) throw new Error('Smart App Builder reference could not be queued')
      queueSmartAppDevelopmentPreview({
        installationId: installation.id,
        displayName: installation.manifest.displayName,
      })
      navigateTo('/')
    } catch (builderError) {
      console.error('[Wework Smart apps] failed to prepare Smart App Builder', builderError)
      setCreateError(
        t('workbench.smart_apps_builder_install_failed', '智能工作台开发助手安装失败，请重试。')
      )
    }
  }

  async function addPluginToInstallation(pluginSpec: string) {
    if (!pluginInstallation) return
    if (pluginInstallation.state === 'running') {
      const stopped = await stopInstalledApp(pluginInstallation, false)
      if (!stopped) throw new Error(t('workbench.harness_apps_stop_failed', '停止智能工作台失败。'))
    }
    await harnessAppsApi.addPlugin(pluginInstallation.id, pluginSpec)
    await refresh()
  }

  async function createSmartApp(input: SmartAppDevelopmentInput) {
    setCreating(true)
    setCreateError(null)
    try {
      const localDeviceId = await getLocalExecutorDeviceId()
      if (!localDeviceId) {
        throw new Error(t('workbench.no_local_project_device', '暂无可用本地设备'))
      }
      const installation = await harnessAppsApi.createDirectory(input)
      notifyHarnessAppInstallationsChanged({
        type: 'installed',
        installationId: installation.id,
        installation,
      })
      await refresh()
      await openBuilder(installation, 'created', {
        deviceId: localDeviceId,
        path: installation.packagePath,
      })
    } finally {
      setCreating(false)
    }
  }

  async function copySmartApp(input: SmartAppDevelopmentInput) {
    if (!copyInstallation) return
    setCreating(true)
    try {
      const installation = await harnessAppsApi.copyToDirectory(copyInstallation.id, {
        parentPath: input.parentPath,
        name: input.name,
        displayName: input.displayName,
      })
      notifyHarnessAppInstallationsChanged({
        type: 'installed',
        installationId: installation.id,
        installation,
      })
      setCopyInstallation(null)
      await refresh()
      await openBuilder(installation, 'develop')
    } finally {
      setCreating(false)
    }
  }

  async function linkSmartAppDirectory() {
    const selected = await invokeDesktopHost<{ canceled: boolean; filePaths: string[] }>(
      'dialog.open',
      {
        properties: ['openDirectory', 'createDirectory'],
      }
    )
    const path = selected.filePaths[0]
    if (selected.canceled || !path) return
    setImporting(true)
    setError(null)
    try {
      const installation = await harnessAppsApi.linkDirectory(path)
      notifyHarnessAppInstallationsChanged({
        type: 'installed',
        installationId: installation.id,
        installation,
      })
      await refresh()
    } catch (value) {
      setError(getErrorMessage(value, t('workbench.smart_apps_link_failed', '关联工作台目录失败')))
    } finally {
      setImporting(false)
    }
  }

  async function importCreatedPackage(path: string) {
    setImporting(true)
    setError(null)
    try {
      const preview = await harnessAppsApi.preview(path)
      if (!preview.valid || !preview.manifest) {
        throw new Error(
          preview.issues.join('；') ||
            t('workbench.smart_apps_invalid_package', '不是有效的智能工作台安装包')
        )
      }
      const installation = await harnessAppsApi.install(preview, null)
      notifyHarnessAppInstallationsChanged({
        type: 'installed',
        installationId: installation.id,
        installation,
      })
      await refresh()
    } catch (importError) {
      setError(
        getErrorMessage(importError, t('workbench.smart_apps_import_failed', '智能工作台导入失败'))
      )
    } finally {
      setImporting(false)
    }
  }

  async function chooseCreatedPackage() {
    const selected = await invokeDesktopHost<{ canceled: boolean; filePaths: string[] }>(
      'dialog.open',
      {
        properties: ['openFile'],
        filters: [
          { name: t('workbench.smart_apps_package', '智能工作台安装包'), extensions: ['zip'] },
        ],
      }
    )
    const path = selected.filePaths[0]
    if (!selected.canceled && path) await importCreatedPackage(path)
  }

  async function dropCreatedPackage(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    const uri = event.dataTransfer.getData('text/uri-list').split(/\r?\n/)[0]?.trim()
    if (!uri) return
    const path = fileUrlToPath(uri)
    if (path) await importCreatedPackage(path)
  }

  function availableUpdate(installation: HarnessAppInstallation) {
    if (!installation.smartAppId) return null
    const marketplace = marketItems.find(item => item.id === installation.smartAppId)
    if (!marketplace || marketplace.latestReleaseId === installation.releaseId) return null
    return marketplace
  }

  function runtimeStateLabel(installation: HarnessAppInstallation) {
    if (installation.state === 'running') {
      return t('workbench.harness_apps_state_running', '运行中')
    }
    if (installation.state === 'failed') {
      return t('workbench.harness_apps_state_failed', '启动失败')
    }
    return t('workbench.harness_apps_state_installed', '已安装')
  }

  function focusModelSelector(installation: HarnessAppInstallation) {
    document
      .querySelector<HTMLSelectElement>(
        `[data-testid="harness-app-model-${CSS.escape(installation.id)}"]`
      )
      ?.focus()
  }

  async function exportInstallation(installation: HarnessAppInstallation) {
    setBusy(installation.id)
    setError(null)
    setExportNotice(null)
    try {
      await harnessAppsApi.exportToDownloads(installation.id)
      setExportNotice(t('workbench.smart_apps_exported', '安装包已导出到下载目录。'))
    } catch (exportError) {
      setError(
        getErrorMessage(exportError, t('workbench.smart_apps_export_failed', '安装包导出失败。'))
      )
    } finally {
      setBusy(null)
    }
  }

  function localActions(
    installation: HarnessAppInstallation,
    item: SmartAppMarketplaceItem | null
  ): ActionMenuItem[] {
    const actions: ActionMenuItem[] = []
    if (mode === 'owned') {
      actions.push({
        label: t('workbench.smart_apps_change_model', '修改模型'),
        icon: Settings2,
        testId: `smart-app-change-model-${installation.id}`,
        disabled: installation.state === 'running',
        onSelect: () => focusModelSelector(installation),
      })
      if (installation.source === 'market') {
        actions.push({
          label: t('workbench.smart_apps_copy_for_development', '复制为我的工作台'),
          icon: Copy,
          testId: `smart-app-copy-${installation.id}`,
          disabled: installation.state === 'running',
          onSelect: () => {
            setCopyInstallation(installation)
            setDevelopmentDialog('copy')
          },
        })
      } else {
        actions.push(
          {
            label: t('workbench.smart_apps_add_plugins', '添加 DSH 插件'),
            icon: Wrench,
            testId: `smart-app-add-plugins-${installation.id}`,
            onSelect: () => setPluginInstallation(installation),
          },
          {
            label: t('workbench.smart_apps_continue_development', '开发工作台'),
            icon: Code2,
            testId: `smart-app-develop-${installation.id}`,
            onSelect: () => void openBuilder(installation, 'develop'),
          },
          {
            label: t('workbench.smart_apps_open_directory', '在文件管理器中打开'),
            icon: FolderOpen,
            testId: `smart-app-open-directory-${installation.id}`,
            onSelect: () => {
              void revealLocalFile(installation.packagePath).catch(openError => {
                setError(
                  getErrorMessage(
                    openError,
                    t('workbench.smart_apps_open_directory_failed', '打开工作台文件夹失败。')
                  )
                )
              })
            },
          }
        )
      }
    }
    if (mode === 'marketplace') {
      actions.push({
        label: t('workbench.smart_apps_manage_in_my', '在我的工作台中管理'),
        icon: Boxes,
        testId: `smart-app-manage-local-${installation.id}`,
        onSelect: () => navigateFromSmartApps('/sites?app_type=smart_app&view=owned'),
      })
    } else if (item?.accessRole === 'owner') {
      actions.push({
        label: t('workbench.smart_apps_manage_access', '管理分享范围'),
        icon: Share2,
        testId: `smart-app-manage-access-${installation.id}`,
        onSelect: () => setShareItem(item),
      })
    }
    if (mode === 'owned' && (!installation.smartAppId || item?.accessRole === 'owner')) {
      actions.push({
        label: t('workbench.smart_apps_export_package', '导出安装包'),
        icon: PackageOpen,
        testId: `smart-app-export-package-${installation.id}`,
        disabled: busy === installation.id,
        onSelect: () => exportInstallation(installation),
      })
    }
    if (installation.state === 'running') {
      actions.push({
        label: t('workbench.harness_apps_stop', '停止'),
        icon: Square,
        testId: `smart-app-stop-menu-${installation.id}`,
        onSelect: () => void stopInstalledApp(installation),
      })
    }
    actions.push(
      { separator: true, label: '', testId: `smart-app-local-separator-${installation.id}` },
      {
        label: t('workbench.smart_apps_remove_local', '从本机移除'),
        icon: Trash2,
        testId: `smart-app-remove-local-${installation.id}`,
        danger: true,
        onSelect: () => setPendingDelete(installation),
      }
    )
    return actions
  }

  async function deleteLocalInstallation() {
    if (!pendingDelete) return
    const installation = pendingDelete
    const installationId = pendingDelete.id
    setBusy(installationId)
    setError(null)
    try {
      if (pendingDelete.state === 'running' && !(await stopInstalledApp(pendingDelete, false))) {
        return
      }
      setBusy(installationId)
      refreshRequestRef.current += 1
      notifyHarnessAppInstallationsChanged({ type: 'removed', installationId })
      setPendingDelete(null)
      await harnessAppsApi.delete(installationId)
      await refresh()
    } catch (deleteError) {
      notifyHarnessAppInstallationsChanged({
        type: 'restored',
        installationId,
        installation,
      })
      setError(
        getErrorMessage(
          deleteError,
          t('workbench.harness_apps_delete_failed', '卸载智能工作台失败。')
        )
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      data-testid={mode === 'owned' ? 'smart-apps-owned-page' : 'smart-apps-marketplace-page'}
      onDragOver={mode === 'owned' ? event => event.preventDefault() : undefined}
      onDrop={mode === 'owned' ? event => void dropCreatedPackage(event) : undefined}
    >
      {mode === 'owned' ? (
        <header className="mb-3 flex justify-end md:absolute md:right-8 md:top-4 md:mb-0">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="smart-apps-created-create"
              onClick={() => setDevelopmentDialog('create')}
            >
              <CirclePlus className="h-4 w-4" />
              {creating
                ? t('workbench.smart_apps_preparing', '正在准备…')
                : t('workbench.smart_apps_create', '创建工作台')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="smart-apps-link-directory"
              disabled={importing}
              onClick={() => void linkSmartAppDirectory()}
            >
              <FolderOpen className="h-4 w-4" />
              {t('workbench.smart_apps_link_directory', '关联文件夹')}
            </Button>
            <Button
              size="sm"
              data-testid="smart-apps-import-button"
              disabled={importing}
              onClick={() => void chooseCreatedPackage()}
            >
              {importing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {importing
                ? t('workbench.smart_apps_importing', '导入中…')
                : t('workbench.smart_apps_import_app', '导入工作台')}
            </Button>
          </div>
        </header>
      ) : null}

      <ApplicationContextToolbar
        leading={
          <SmartAppsSectionNav
            active={mode === 'owned' ? 'owned' : 'marketplace'}
            onNavigate={navigateFromSmartApps}
          />
        }
        searchLabel={t('workbench.smart_apps_search', '搜索工作台')}
        searchPlaceholder={t('workbench.smart_apps_search', '搜索工作台')}
        searchTestId={
          mode === 'owned' ? 'smart-apps-owned-search' : 'smart-apps-marketplace-search'
        }
        value={query}
        onValueChange={setQuery}
        trailing={
          mode === 'marketplace' ? (
            <>
              <select
                data-testid="smart-apps-marketplace-source"
                value={source}
                className="h-full min-w-32 rounded-lg border border-border/50 bg-background px-3 text-sm outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
                onChange={event => setSource(event.target.value as typeof source)}
              >
                <option value="all">{t('workbench.smart_apps_source_all', '全部来源')}</option>
                <option value="official">
                  {t('workbench.smart_apps_source_official', '官方工作台')}
                </option>
                <option value="public">
                  {t('workbench.smart_apps_source_public', '全员应用')}
                </option>
                <option value="shared">
                  {t('workbench.smart_apps_source_shared', '分享给我')}
                </option>
              </select>
              <select
                data-testid="smart-apps-marketplace-tag"
                value={tag}
                className="h-full min-w-32 rounded-lg border border-border/50 bg-background px-3 text-sm outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
                onChange={event => setTag(event.target.value)}
              >
                <option value="">{t('workbench.smart_apps_tag_all', '全部标签')}</option>
                {tags.map(item => (
                  <option key={item.id} value={item.id}>
                    {i18n.language.startsWith('zh') ? item.name_zh : item.name_en}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <div
              className="flex h-full items-center rounded-lg border border-border/50 bg-surface/40 p-0.5"
              data-testid="smart-apps-owned-filters"
            >
              {(
                [
                  ['all', t('workbench.smart_apps_filter_all', '全部'), ownedCards.length],
                  [
                    'created',
                    t('workbench.smart_apps_filter_created', '我创建/导入的'),
                    ownedCards.filter(card => card.category === 'created').length,
                  ],
                  [
                    'installed',
                    t('workbench.smart_apps_filter_installed', '我安装的'),
                    ownedCards.filter(card => card.category === 'installed').length,
                  ],
                ] as Array<[OwnedFilter, string, number]>
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`smart-apps-owned-filter-${value}`}
                  aria-pressed={ownedFilter === value}
                  className={`h-full rounded-md px-3 text-sm transition-colors ${
                    ownedFilter === value
                      ? 'bg-background font-medium text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                  onClick={() => setOwnedFilter(value)}
                >
                  {label} <span className="ml-1 text-xs text-text-muted">{count}</span>
                </button>
              ))}
            </div>
          )
        }
      />

      {!loading && hasItems ? (
        <div className="mt-4 flex min-h-8 items-center justify-between gap-4 text-xs text-text-muted">
          <span>
            {t('workbench.smart_apps_result_count', '共 {{count}} 个工作台').replace(
              '{{count}}',
              String(mode === 'owned' ? visibleOwnedCards.length : items.length)
            )}
          </span>
          {mode === 'marketplace' ? (
            <select
              data-testid="smart-apps-marketplace-sort"
              value={marketplaceSort}
              aria-label={t('workbench.smart_apps_sort_label', '排序方式')}
              className="h-8 rounded-lg border border-transparent bg-transparent px-2 text-sm text-text-primary outline-none hover:bg-muted focus:border-focus focus:ring-2 focus:ring-focus/15"
              onChange={event => setMarketplaceSort(event.target.value as MarketplaceSort)}
            >
              <option value="recommended">
                {t('workbench.smart_apps_sort_recommended', '推荐排序')}
              </option>
              <option value="updated">{t('workbench.smart_apps_sort_updated', '最近更新')}</option>
            </select>
          ) : null}
        </div>
      ) : null}

      {createError || error ? (
        <p role="alert" className="mt-4 rounded-lg bg-danger/10 p-3 text-sm text-danger">
          {createError ?? error}
        </p>
      ) : null}

      {exportNotice ? (
        <p
          role="status"
          data-testid="smart-app-export-success"
          className="mt-4 flex items-center gap-2 rounded-lg bg-success/10 p-3 text-sm text-success"
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {exportNotice}
        </p>
      ) : null}

      {mode === 'owned' && accessNotice ? (
        <div
          role="status"
          data-testid="smart-app-access-success"
          className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-success/10 p-3 text-sm text-success"
        >
          <span className="flex min-w-0 items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {accessNotice.message}
          </span>
          {accessNotice.showMarketplace ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-success/30 bg-background text-text-primary shadow-sm hover:bg-success/10"
              data-testid="smart-app-access-view-marketplace"
              onClick={() => navigateFromSmartApps('/sites?app_type=smart_app')}
            >
              {t('workbench.smart_apps_view_marketplace', '去市场查看')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {!api && mode === 'marketplace' ? (
        <EmptyState
          icon={<Box className="h-6 w-6" />}
          title={t('workbench.smart_apps_cloud_required', '连接云端后使用智能工作台市场')}
          description={t(
            'workbench.smart_apps_cloud_required_hint',
            '本地已安装工作台不受影响，仍可离线管理和运行。'
          )}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigateFromSmartApps('/sites?app_type=smart_app&view=owned')}
            >
              <PackageCheck className="h-4 w-4" />
              {t('workbench.smart_apps_view_my', '查看我的工作台')}
            </Button>
          }
        />
      ) : loading ? (
        <div className="flex min-h-72 items-center justify-center text-text-muted">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {t('workbench.smart_apps_loading', '正在加载')}
        </div>
      ) : !hasItems ? (
        <EmptyState
          icon={<Box className="h-6 w-6" />}
          title={
            mode === 'owned'
              ? t('workbench.smart_apps_my_empty', '还没有符合条件的工作台')
              : t('workbench.smart_apps_marketplace_empty', '没有找到智能工作台')
          }
          description={
            mode === 'owned'
              ? t(
                  'workbench.smart_apps_my_empty_hint',
                  '可以调整筛选条件、从市场安装，或导入一个本地 ZIP 工作台。'
                )
              : t(
                  'workbench.smart_apps_marketplace_empty_hint',
                  '可以调整搜索条件，或稍后再来看看。'
                )
          }
        />
      ) : (
        <div
          data-testid={mode === 'owned' ? 'smart-apps-created-list' : undefined}
          className="mt-3 grid gap-4 md:grid-cols-2"
        >
          {mode === 'owned'
            ? visibleOwnedCards.map(card => {
                const { installation, item } = card
                const title = item?.displayName ?? installation?.manifest.displayName ?? ''
                const description = item?.summary ?? installation?.manifest.description ?? ''
                const isOwner = item?.accessRole === 'owner'
                const sameVersion = Boolean(
                  item && installation && item.version === installation.manifest.version
                )
                const update = installation ? availableUpdate(installation) : null
                const shouldPublish = Boolean(
                  card.category === 'created' && installation && (!item || !sameVersion)
                )
                const stateTone =
                  installation?.state === 'failed'
                    ? 'danger'
                    : update
                      ? 'accent'
                      : installation
                        ? 'success'
                        : 'muted'
                const stateLabel = installation
                  ? update
                    ? t('workbench.smart_apps_update_available', '有可用更新')
                    : runtimeStateLabel(installation)
                  : t('workbench.smart_apps_not_installed', '未安装')
                return (
                  <SmartAppCard
                    key={card.key}
                    testId={
                      card.category === 'created' && installation
                        ? `smart-app-created-item-${installation.id}`
                        : item
                          ? `smart-app-owned-item-${item.id}`
                          : undefined
                    }
                    iconUrl={item?.iconUrl}
                    title={title}
                    sourceLabel={
                      card.category === 'created'
                        ? installation?.source === 'linked'
                          ? t('workbench.smart_apps_linked_folder', '关联文件夹')
                          : installation && !installation.smartAppId
                            ? t('workbench.smart_apps_local_import', '本地导入')
                            : t('workbench.smart_apps_created_by_me', '我创建')
                        : t('workbench.smart_apps_market_install', '市场安装')
                    }
                    description={description}
                    tags={item?.tags ?? []}
                    visibility={{
                      kind: item?.visibility ?? 'private',
                      label:
                        item?.visibility === 'public'
                          ? t('workbench.smart_apps_visibility_public', '全员')
                          : item?.visibility === 'restricted'
                            ? t('workbench.smart_apps_visibility_restricted', '指定成员')
                            : t('workbench.smart_apps_visibility_private', '仅自己'),
                      onClick: isOwner && item ? () => setShareItem(item) : undefined,
                      testId: item ? `smart-app-visibility-${item.id}` : undefined,
                    }}
                    stateLabel={stateLabel}
                    stateTone={stateTone}
                    version={installation?.manifest.version ?? item?.version ?? ''}
                    onDetails={item ? () => setSelected(item) : undefined}
                    supplementary={
                      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-xs text-text-muted">
                        {installation ? (
                          <label className="flex min-w-0 items-center gap-1">
                            <span>{t('workbench.harness_apps_bound_model', '模型')}：</span>
                            <select
                              data-testid={`harness-app-model-${installation.id}`}
                              aria-label={t('workbench.smart_apps_change_model', '修改模型')}
                              className="min-w-0 max-w-44 rounded-md border border-border/50 bg-background px-1.5 py-0.5 text-xs text-text-secondary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15 disabled:cursor-not-allowed disabled:opacity-60"
                              value={installation.modelKey ?? ''}
                              disabled={
                                busy === installation.id || installation.state === 'running'
                              }
                              onChange={event => void changeModel(installation, event.target.value)}
                            >
                              {!installation.modelKey ? (
                                <option value="">
                                  {t('workbench.harness_apps_model_choose', '请选择模型')}
                                </option>
                              ) : null}
                              {modelOptions.map(option => (
                                <option key={option.key} value={option.key}>
                                  {option.label}
                                </option>
                              ))}
                              {!hasSelectedModel(installation) && installation.modelKey ? (
                                <option value={installation.modelKey}>
                                  {t('workbench.harness_apps_model_unavailable', '模型不可用')}
                                </option>
                              ) : null}
                            </select>
                          </label>
                        ) : null}
                        {item?.updatedAt ? (
                          <span>
                            {t('workbench.smart_apps_updated_relative', '更新于 {{time}}').replace(
                              '{{time}}',
                              formatUpdatedAt(item.updatedAt, i18n?.language ?? 'zh-CN')
                            )}
                          </span>
                        ) : null}
                      </div>
                    }
                    actions={
                      <>
                        {shouldPublish && installation ? (
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid={`smart-app-created-publish-${installation.id}`}
                            disabled={!api || busy === installation.id}
                            onClick={() => {
                              setPublishInstallation(installation)
                              setPublishItem(item)
                            }}
                          >
                            <Upload className="h-4 w-4" />
                            {item
                              ? t('workbench.smart_apps_publish_version', '发布新版本')
                              : t('workbench.smart_apps_publish', '发布')}
                          </Button>
                        ) : null}
                        {update ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === installation?.id}
                            onClick={() => void download(update)}
                          >
                            <Download className="h-4 w-4" />
                            {t('workbench.smart_apps_update', '更新')}
                          </Button>
                        ) : null}
                        {installation ? (
                          installation.state === 'running' ? (
                            <Button
                              size="sm"
                              data-testid={`harness-app-open-${installation.id}`}
                              disabled={busy === installation.id}
                              onClick={() => openInstalledApp(installation)}
                            >
                              <ExternalLink className="h-4 w-4" />
                              {t('workbench.harness_apps_open', '打开')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              data-testid={`harness-app-start-${installation.id}`}
                              disabled={busy === installation.id || !hasSelectedModel(installation)}
                              onClick={() => startInstalledApp(installation)}
                            >
                              <Play className="h-4 w-4" />
                              {t('workbench.harness_apps_start', '运行')}
                            </Button>
                          )
                        ) : item ? (
                          <Button
                            size="sm"
                            data-testid={`smart-app-owned-install-${item.id}`}
                            disabled={busy === `download-${item.id}`}
                            onClick={() => void download(item)}
                          >
                            <Download className="h-4 w-4" />
                            {t('workbench.harness_apps_install', '安装')}
                          </Button>
                        ) : null}
                        {isOwner ? (
                          <Button size="sm" variant="outline" onClick={() => setShareItem(item)}>
                            {t('workbench.smart_apps_manage_access', '管理范围')}
                          </Button>
                        ) : null}
                        {installation ? (
                          <ActionMenu
                            ariaLabel={t('workbench.smart_apps_more_actions', '更多操作')}
                            testId={`smart-app-actions-${installation.id}`}
                            items={localActions(installation, item)}
                            placement="bottom-end"
                            triggerClassName="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
                          />
                        ) : null}
                      </>
                    }
                  />
                )
              })
            : null}
          {mode === 'marketplace' &&
            visibleMarketplaceItems.map(item => {
              const state = localState(item)
              const modelLabel = state
                ? (modelOptions.find(option => option.key === state.installation.modelKey)?.label ??
                  t('workbench.harness_apps_model_unavailable', '模型不可用'))
                : t('workbench.smart_apps_model_selected_on_install', '安装时选择')
              return (
                <SmartAppCard
                  key={item.id}
                  testId={`smart-app-marketplace-item-${item.id}`}
                  iconUrl={item.iconUrl}
                  title={item.displayName}
                  sourceLabel={
                    item.sourceType === 'official'
                      ? t('workbench.smart_apps_official', '官方')
                      : item.accessRole === 'owner'
                        ? t('workbench.smart_apps_published_by_me', '我发布的')
                        : item.accessRole === 'public'
                          ? t('workbench.smart_apps_public_for_everyone', '全员应用')
                          : t('workbench.smart_apps_shared_with_me', '分享给我')
                  }
                  description={item.summary}
                  tags={item.tags}
                  visibility={{
                    kind: item.visibility,
                    label:
                      item.visibility === 'public'
                        ? t('workbench.smart_apps_visibility_public', '全员')
                        : t('workbench.smart_apps_visibility_restricted', '指定成员'),
                  }}
                  stateLabel={
                    state
                      ? state.update
                        ? t('workbench.smart_apps_update_available', '有可用更新')
                        : runtimeStateLabel(state.installation)
                      : t('workbench.smart_apps_not_installed', '未安装')
                  }
                  stateTone={
                    state?.installation.state === 'failed'
                      ? 'danger'
                      : state?.update
                        ? 'accent'
                        : state
                          ? 'success'
                          : 'muted'
                  }
                  version={item.version}
                  supplementary={
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-text-muted">
                      <span>
                        {t('workbench.harness_apps_bound_model', '模型')}：{modelLabel}
                      </span>
                      <span>
                        {t('workbench.smart_apps_size', '大小')}：{formatBytes(item.sizeBytes)}
                      </span>
                    </div>
                  }
                  onDetails={() => setSelected(item)}
                  actions={
                    <>
                      {state ? (
                        state.update ? (
                          <Button
                            size="sm"
                            data-testid={`smart-app-marketplace-install-${item.id}`}
                            disabled={busy === `download-${item.id}`}
                            onClick={() => void download(item)}
                          >
                            <Download className="h-4 w-4" />
                            {t('workbench.smart_apps_update', '更新')}
                          </Button>
                        ) : state.installation.state === 'running' ? (
                          <Button
                            size="sm"
                            data-testid={`harness-app-open-${state.installation.id}`}
                            disabled={busy === state.installation.id}
                            onClick={() => openInstalledApp(state.installation)}
                          >
                            <ExternalLink className="h-4 w-4" />
                            {t('workbench.harness_apps_open', '打开')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            data-testid={`harness-app-start-${state.installation.id}`}
                            disabled={
                              busy === state.installation.id ||
                              !hasSelectedModel(state.installation)
                            }
                            onClick={() => startInstalledApp(state.installation)}
                          >
                            <Play className="h-4 w-4" />
                            {t('workbench.harness_apps_start', '运行')}
                          </Button>
                        )
                      ) : (
                        <Button
                          size="sm"
                          data-testid={`smart-app-marketplace-install-${item.id}`}
                          disabled={busy === `download-${item.id}`}
                          onClick={() => void download(item)}
                        >
                          {busy === `download-${item.id}` ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}
                          {t('workbench.harness_apps_install', '安装')}
                        </Button>
                      )}
                      {state ? (
                        <ActionMenu
                          ariaLabel={t('workbench.smart_apps_more_actions', '更多操作')}
                          testId={`smart-app-marketplace-actions-${item.id}`}
                          items={localActions(state.installation, item)}
                          placement="bottom-end"
                          triggerClassName="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
                        />
                      ) : null}
                    </>
                  }
                />
              )
            })}
        </div>
      )}

      {selected ? (
        <SmartAppDetails
          item={selected}
          state={localState(selected)}
          busy={busy === `download-${selected.id}`}
          onClose={() => setSelected(null)}
          onInstall={() => void download(selected)}
        />
      ) : null}
      {pendingInstall ? (
        <HarnessAppInstallDialog
          busy={busy === 'install'}
          error={error}
          modelKey={installModelKey}
          modelOptions={modelOptions}
          preview={pendingInstall.preview}
          onCancel={() => setPendingInstall(null)}
          onInstall={() => void install()}
          onModelChange={setModelKey}
        />
      ) : null}
      {publishItem !== undefined && api ? (
        <SmartAppPublishDialog
          api={api}
          item={publishItem}
          installation={publishInstallation}
          tags={tags}
          onClose={() => {
            setPublishItem(undefined)
            setPublishInstallation(null)
          }}
          onPublished={() => {
            setPublishItem(undefined)
            setPublishInstallation(null)
            void refresh()
          }}
        />
      ) : null}
      {shareItem && api ? (
        <SmartAppShareDialog
          api={api}
          item={shareItem}
          onClose={() => setShareItem(null)}
          onSaved={savedAccess => {
            setShareItem(null)
            setExportNotice(null)
            setAccessNotice({
              message:
                savedAccess.scope === 'public'
                  ? savedAccess.isListed
                    ? t(
                        'workbench.smart_apps_listed_success',
                        'v{{version}} 已上架到智能应用市场。'
                      ).replace('{{version}}', savedAccess.version)
                    : t(
                        'workbench.smart_apps_public_unlisted_success',
                        '已发布给全员，但当前已被管理员下架。'
                      )
                  : t('workbench.smart_apps_access_saved', '分享范围已保存。'),
              showMarketplace: savedAccess.scope === 'public' && savedAccess.isListed,
            })
            void refresh()
          }}
        />
      ) : null}
      {developmentDialog ? (
        <SmartAppDevelopmentDialog
          mode={developmentDialog}
          initialDisplayName={
            developmentDialog === 'copy' ? copyInstallation?.manifest.displayName : undefined
          }
          onClose={() => {
            setDevelopmentDialog(null)
            if (developmentDialog === 'copy') setCopyInstallation(null)
          }}
          onSubmit={developmentDialog === 'copy' ? copySmartApp : createSmartApp}
        />
      ) : null}
      {pluginInstallation ? (
        <SmartAppPluginDialog
          displayName={pluginInstallation.manifest.displayName}
          onClose={() => setPluginInstallation(null)}
          onInstall={addPluginToInstallation}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t('workbench.smart_apps_remove_local_title', '从本机移除工作台？')}
        description={
          pendingDelete?.source === 'linked'
            ? t(
                'workbench.smart_apps_unlink_local_description',
                '将停止运行并从列表中移除，但不会删除工作台文件夹。'
              )
            : t(
                'workbench.smart_apps_remove_local_description',
                '将停止运行并删除本机文件。已发布版本和分享范围不会受到影响。'
              )
        }
        cancelLabel={t('common.cancel', '取消')}
        confirmLabel={t('workbench.smart_apps_remove_local_confirm', '移除')}
        confirmTestId="smart-app-remove-local-confirm"
        destructive
        pending={Boolean(pendingDelete && busy === pendingDelete.id)}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void deleteLocalInstallation()}
      />
    </section>
  )
}

function SmartAppCard({
  actions,
  description,
  iconUrl,
  onDetails,
  sourceLabel,
  stateLabel,
  stateTone,
  supplementary,
  tags,
  testId,
  title,
  version,
  visibility,
}: {
  actions: React.ReactNode
  description: string
  iconUrl?: string
  onDetails?: () => void
  sourceLabel?: string
  stateLabel: string
  stateTone: 'accent' | 'danger' | 'muted' | 'success'
  supplementary?: React.ReactNode
  tags: string[]
  testId?: string
  title: string
  version: string
  visibility: {
    kind: 'private' | 'public' | 'restricted'
    label: string
    onClick?: () => void
    testId?: string
  }
}) {
  const stateClassName =
    stateTone === 'success'
      ? 'text-success'
      : stateTone === 'danger'
        ? 'text-red-500'
        : stateTone === 'accent'
          ? 'text-blue-600'
          : 'text-text-muted'
  const VisibilityIcon =
    visibility.kind === 'public' ? Globe2 : visibility.kind === 'restricted' ? Users : LockKeyhole
  const visibilityContent = (
    <>
      <VisibilityIcon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{visibility.label}</span>
    </>
  )
  const identity = (
    <>
      {iconUrl ? (
        <img src={iconUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
      ) : (
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border/40 bg-surface/30 text-text-secondary">
          <Box className="h-6 w-6" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base font-medium text-text-primary">{title}</span>
          {sourceLabel ? (
            <span className="shrink-0 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-text-muted">
              {sourceLabel}
            </span>
          ) : null}
        </span>
        <span className="mt-1 line-clamp-2 text-sm leading-5 text-text-secondary">
          {description}
        </span>
        {tags.length > 0 ? (
          <span className="mt-2 flex flex-wrap gap-1">
            {tags.slice(0, 3).map(tag => (
              <span
                key={tag}
                className="rounded-md bg-muted/45 px-2 py-0.5 text-xs text-text-muted"
              >
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </>
  )

  return (
    <article
      data-testid={testId}
      className="flex min-h-52 flex-col rounded-2xl border border-border/45 bg-background p-5 transition-colors hover:border-border/70 hover:bg-surface/20"
    >
      {onDetails ? (
        <button
          type="button"
          className="flex items-start gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
          onClick={onDetails}
        >
          {identity}
        </button>
      ) : (
        <div className="flex items-start gap-4">{identity}</div>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-4 text-xs">
        {visibility.onClick ? (
          <button
            type="button"
            data-testid={visibility.testId}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/50 bg-background px-2 text-text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
            onClick={visibility.onClick}
          >
            {visibilityContent}
          </button>
        ) : (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/50 px-2 text-text-primary">
            {visibilityContent}
          </span>
        )}
        <span
          data-testid={testId ? `${testId}-state` : undefined}
          className={`inline-flex items-center gap-1.5 ${stateClassName}`}
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {stateLabel}
        </span>
        <span className="inline-flex items-center gap-1.5 text-text-muted">
          <Puzzle className="h-3.5 w-3.5" aria-hidden="true" />v{version}
        </span>
      </div>
      <div className="mt-4 flex min-h-9 flex-wrap items-end justify-between gap-3 border-t border-border/40 pt-4">
        <div className="min-w-0 flex-1">{supplementary}</div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
      </div>
    </article>
  )
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="mt-5 flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-border/45 bg-background px-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/30 bg-background text-text-secondary">
        {icon}
      </div>
      <strong className="mt-5 font-medium">{title}</strong>
      <p className="mt-2 max-w-md text-sm leading-6 text-text-muted">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

function SmartAppDetails({
  item,
  state,
  busy,
  onClose,
  onInstall,
}: {
  item: SmartAppMarketplaceItem
  state: { installation: HarnessAppInstallation; update: boolean } | null
  busy: boolean
  onClose: () => void
  onInstall: () => void
}) {
  const { t } = useTranslation('common')
  const closeRef = useRef<HTMLButtonElement>(null)
  const rawDescription = (item.descriptionMd || item.summary).trim()
  const descriptionLines = rawDescription.split(/\r?\n/)
  const firstHeading = descriptionLines[0]?.trim().replace(/^#+\s*/, '')
  const description =
    firstHeading === item.displayName
      ? descriptionLines.slice(1).join('\n').trim() || item.summary
      : rawDescription

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-app-details-title"
        data-testid="smart-app-details"
        className="plugin-dialog-surface flex max-h-[min(760px,92dvh)] w-full max-w-[720px] flex-col overflow-hidden rounded-b-none sm:rounded-b-[20px]"
        onClick={event => event.stopPropagation()}
      >
        <header
          className="plugin-dialog-divider flex shrink-0 items-start gap-4 border-b px-5 py-4 sm:px-6 sm:py-5"
          data-testid="smart-app-details-header"
        >
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/30 bg-surface">
            {item.iconUrl ? (
              <img src={item.iconUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <Boxes className="h-6 w-6 text-text-muted" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="smart-app-details-title" className="heading-subsection truncate">
              {item.displayName}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {item.sourceType === 'official'
                ? t('workbench.smart_apps_wework_official', 'Wework 官方')
                : t('workbench.smart_apps_publisher', '发布者：{{name}}').replace(
                    '{{name}}',
                    item.ownerDisplayName
                  )}{' '}
              · v{item.version}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label={t('common.close', '关闭')}
            data-testid="smart-app-details-close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface hover:text-text-primary"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div
          className="scrollbar-soft min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6"
          data-testid="smart-app-details-content"
        >
          <div className="grid overflow-hidden rounded-xl border border-border/30 bg-surface/35 text-sm sm:grid-cols-3 sm:divide-x sm:divide-border/30">
            <div className="flex min-h-14 items-center gap-2.5 px-4 py-3">
              <ShieldCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <span className="font-medium text-text-primary">
                {t('workbench.smart_apps_scan_passed', '安全扫描通过')}
              </span>
            </div>
            <div className="flex min-h-14 items-center gap-2.5 border-t border-border/30 px-4 py-3 sm:border-t-0">
              <PackageOpen className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <span className="text-text-secondary">{formatBytes(item.sizeBytes)}</span>
            </div>
            <div className="flex min-h-14 items-center gap-2.5 border-t border-border/30 px-4 py-3 sm:border-t-0">
              <CalendarDays className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <span className="text-text-secondary">
                {t('workbench.smart_apps_updated_at', '更新于 {{date}}').replace(
                  '{{date}}',
                  new Date(item.updatedAt).toLocaleDateString()
                )}
              </span>
            </div>
          </div>

          {item.screenshotUrls.length ? (
            <div className="mt-5 flex snap-x gap-3 overflow-x-auto pb-1">
              {item.screenshotUrls.map(url => (
                <img
                  key={url}
                  src={url}
                  alt={t('workbench.smart_apps_screenshot', '工作台截图')}
                  className="h-44 shrink-0 snap-start rounded-xl border border-border/40 object-cover"
                />
              ))}
            </div>
          ) : null}

          <article
            className="mt-5 text-sm leading-6 text-text-secondary"
            data-testid="smart-app-details-description"
          >
            <ReactMarkdown
              components={{
                h1: ({ children }) => (
                  <h3 className="mb-2 mt-5 text-base font-medium text-text-primary first:mt-0">
                    {children}
                  </h3>
                ),
                h2: ({ children }) => (
                  <h3 className="mb-2 mt-5 text-base font-medium text-text-primary first:mt-0">
                    {children}
                  </h3>
                ),
                h3: ({ children }) => (
                  <h4 className="mb-2 mt-4 text-sm font-medium text-text-primary first:mt-0">
                    {children}
                  </h4>
                ),
                p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                ul: ({ children }) => (
                  <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0">{children}</ul>
                ),
                ol: ({ children, start }) => (
                  <ol start={start} className="mb-3 list-decimal space-y-1.5 pl-5 last:mb-0">
                    {children}
                  </ol>
                ),
                li: ({ children }) => <li className="pl-0.5">{children}</li>,
                strong: ({ children }) => (
                  <strong className="font-medium text-text-primary">{children}</strong>
                ),
                code: ({ children }) => (
                  <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs text-text-primary">
                    {children}
                  </code>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="my-3 border-l-2 border-border pl-3 text-text-muted">
                    {children}
                  </blockquote>
                ),
              }}
            >
              {description}
            </ReactMarkdown>
          </article>

          {item.releaseNotes ? (
            <section className="plugin-dialog-divider mt-5 border-t pt-4">
              <h3 className="text-sm font-medium text-text-primary">
                {t('workbench.smart_apps_release_notes', '版本说明')}
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-text-secondary">
                {item.releaseNotes}
              </p>
            </section>
          ) : null}
        </div>
        <footer
          className="plugin-dialog-divider flex shrink-0 justify-end border-t px-5 py-4 sm:px-6"
          data-testid="smart-app-details-footer"
        >
          <Button
            size="sm"
            className="min-w-28"
            disabled={busy || Boolean(state && !state.update)}
            onClick={onInstall}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : state && !state.update ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
            {state
              ? state.update
                ? t('workbench.smart_apps_update', '更新')
                : t('workbench.smart_apps_installed', '已安装')
              : t('workbench.smart_apps_download_install', '下载并安装')}
          </Button>
        </footer>
      </section>
    </div>
  )
}

function TargetPicker({
  api,
  targets,
  onChange,
}: {
  api: SmartAppsApi
  targets: SmartAppAccessTarget[]
  onChange: (targets: SmartAppAccessTarget[]) => void
}) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SmartAppAccessTarget[]>([])
  useEffect(() => {
    if (!query.trim()) {
      queueMicrotask(() => setResults([]))
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      Promise.all([api.searchUsers(query), api.searchGroups(query)])
        .then(([users, groups]) => {
          if (!active) return
          setResults([
            ...users.map(user => ({
              entityType: 'user' as const,
              entityId: String(user.id),
              displayName: user.user_name,
            })),
            ...groups.map(group => ({
              entityType: 'namespace' as const,
              entityId: String(group.id),
              displayName: group.display_name || group.name,
            })),
          ])
        })
        .catch(() => setResults([]))
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, query])
  return (
    <div>
      <label className="relative block">
        <Search className="absolute left-3 top-3 h-4 w-4 text-text-muted" />
        <input
          data-testid="smart-app-target-search"
          value={query}
          placeholder={t('workbench.smart_apps_target_search', '搜索成员或部门')}
          className="h-10 w-full rounded-lg border border-border pl-9 pr-3 text-sm"
          onChange={event => setQuery(event.target.value)}
        />
      </label>
      {results.length ? (
        <div className="mt-1 max-h-36 overflow-y-auto rounded-lg border bg-background p-1">
          {results.map(result => (
            <button
              key={`${result.entityType}-${result.entityId}`}
              type="button"
              className="flex w-full justify-between rounded-md px-3 py-2 text-sm hover:bg-surface"
              onClick={() => {
                if (
                  !targets.some(
                    value =>
                      value.entityType === result.entityType && value.entityId === result.entityId
                  )
                )
                  onChange([...targets, result])
                setQuery('')
              }}
            >
              <span>{result.displayName}</span>
              <span className="text-xs text-text-muted">
                {result.entityType === 'user'
                  ? t('workbench.smart_apps_member', '成员')
                  : t('workbench.smart_apps_department', '部门')}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {targets.map(target => (
          <span
            key={`${target.entityType}-${target.entityId}`}
            className="inline-flex items-center gap-1 rounded-lg bg-surface px-2 py-1 text-sm"
          >
            {target.displayName}
            <button
              type="button"
              aria-label={t('workbench.smart_apps_remove_target', '移除 {{name}}').replace(
                '{{name}}',
                target.displayName
              )}
              onClick={() => onChange(targets.filter(value => value !== target))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}

function SmartAppShareDialog({
  api,
  item,
  onClose,
  onSaved,
}: {
  api: SmartAppsApi
  item: SmartAppMarketplaceItem
  onClose: () => void
  onSaved: (access: SmartAppAccess) => void
}) {
  const { t } = useTranslation('common')
  const [access, setAccess] = useState<SmartAppAccess | null>(null)
  const [scope, setScope] = useState<'private' | 'restricted' | 'public'>('restricted')
  const [targets, setTargets] = useState<SmartAppAccessTarget[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void api
      .getAccess(item.id)
      .then(value => {
        setAccess(value)
        setScope(value.scope)
        setTargets(value.targets)
      })
      .catch(value =>
        setError(
          getErrorMessage(value, t('workbench.smart_apps_access_load_failed', '分享范围加载失败'))
        )
      )
  }, [api, item.id, t])
  async function save() {
    if (scope === 'restricted' && !targets.length) {
      setError(
        t('workbench.smart_apps_access_target_required', '请至少选择一个成员或部门，或切换为仅自己')
      )
      return
    }
    setSaving(true)
    try {
      const savedAccess = await api.updateAccess(item.id, {
        scope,
        targets: scope === 'restricted' ? targets : [],
      })
      onSaved(savedAccess)
    } catch (value) {
      setError(
        getErrorMessage(value, t('workbench.smart_apps_access_save_failed', '分享范围保存失败'))
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        data-testid="smart-app-share-dialog"
        className="plugin-dialog-surface w-full max-w-lg p-5"
      >
        <header className="flex justify-between">
          <div>
            <h2 className="heading-small">{t('workbench.smart_apps_manage_access', '管理分享')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{item.displayName}</p>
          </div>
          <button
            aria-label={t('common.close', '关闭')}
            data-testid="smart-app-share-close"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {access ? (
          <>
            <div className="mt-5 grid grid-cols-3 gap-2 rounded-xl bg-surface p-1">
              <button
                type="button"
                className={`h-11 rounded-lg ${scope === 'private' ? 'bg-background shadow-sm' : ''}`}
                onClick={() => setScope('private')}
                data-testid="smart-app-share-scope-private"
              >
                {t('workbench.smart_apps_private', '仅自己')}
              </button>
              <button
                type="button"
                className={`h-11 rounded-lg ${scope === 'restricted' ? 'bg-background shadow-sm' : ''}`}
                onClick={() => setScope('restricted')}
                data-testid="smart-app-share-scope-restricted"
              >
                {t('workbench.smart_apps_restricted', '指定成员/部门')}
              </button>
              <button
                type="button"
                className={`h-11 rounded-lg ${scope === 'public' ? 'bg-background shadow-sm' : ''}`}
                onClick={() => setScope('public')}
                data-testid="smart-app-share-scope-public"
              >
                {t('workbench.smart_apps_public', '全员')}
              </button>
            </div>
            {scope === 'restricted' ? (
              <div className="mt-4">
                <TargetPicker api={api} targets={targets} onChange={setTargets} />
              </div>
            ) : (
              <p className="mt-4 text-sm text-text-secondary">
                {scope === 'public'
                  ? t(
                      'workbench.smart_apps_share_public_hint',
                      '将当前已发布版本 v{{version}} 上架到智能应用市场，所有成员均可查看和安装。本地后续修改不会自动同步，需发布新版本。'
                    ).replace('{{version}}', item.version)
                  : t(
                      'workbench.smart_apps_revoke_hint',
                      '取消分享后，接收者不能继续下载或更新；已安装到本地的副本仍可离线运行。'
                    )}
              </p>
            )}
          </>
        ) : (
          <p className="mt-5 text-sm text-text-muted">
            {t('workbench.smart_apps_loading', '正在加载…')}
          </p>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <footer className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} data-testid="smart-app-share-cancel">
            {t('common.cancel', '取消')}
          </Button>
          <Button
            disabled={!access || saving}
            onClick={() => void save()}
            data-testid="smart-app-share-save"
          >
            {saving ? t('workbench.smart_apps_saving', '保存中…') : t('common.save', '保存')}
          </Button>
        </footer>
      </section>
    </div>
  )
}

function SmartAppPublishDialog({
  api,
  item,
  installation,
  tags,
  onClose,
  onPublished,
}: {
  api: SmartAppsApi
  item: SmartAppMarketplaceItem | null
  installation: HarnessAppInstallation | null
  tags: SmartAppMarketplaceTag[]
  onClose: () => void
  onPublished: () => void
}) {
  const { t, i18n } = useTranslation('common')
  const [file, setFile] = useState<File | null>(null)
  const [manifest, setManifest] = useState<HarnessAppManifest | null>(
    installation?.manifest ?? null
  )
  const [summary, setSummary] = useState(item?.summary ?? installation?.manifest.description ?? '')
  const [description, setDescription] = useState(item?.descriptionMd ?? '')
  const [selectedTags, setSelectedTags] = useState<string[]>(item?.tags ?? [])
  const [icon, setIcon] = useState<File | null>(null)
  const [screenshots, setScreenshots] = useState<File[]>([])
  const [notes, setNotes] = useState('')
  const [scope, setScope] = useState<'restricted' | 'public'>('restricted')
  const [targets, setTargets] = useState<SmartAppAccessTarget[]>([])
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function choosePackage(next: File | null) {
    setFile(next)
    setManifest(null)
    setError(null)
    if (!next) return
    try {
      const parsed = await readManifest(next, {
        missingManifest: t(
          'workbench.smart_apps_manifest_required',
          '安装包必须包含一个 plugin-manifest.json'
        ),
        invalidPackage: t('workbench.smart_apps_invalid_package', '不是有效的智能工作台安装包'),
      })
      if (item && parsed.name !== item.name) {
        throw new Error(
          t('workbench.smart_apps_version_name_mismatch', '新版本的工作台名称必须与原工作台一致')
        )
      }
      setManifest(parsed)
      setSummary(value => value || parsed.description)
    } catch (value) {
      setError(
        getErrorMessage(value, t('workbench.smart_apps_package_parse_failed', '安装包解析失败'))
      )
    }
  }
  async function publish() {
    if ((!file && !installation) || !manifest || !icon || !summary.trim() || !selectedTags.length) {
      setError(
        t('workbench.smart_apps_publish_fields_required', '请完整填写安装包、简介、标签和图标')
      )
      return
    }
    if (!item && scope === 'restricted' && !targets.length) {
      setError(
        t('workbench.smart_apps_first_target_required', '首次发布必须选择至少一个成员或部门')
      )
      return
    }
    setPublishing(true)
    setError(null)
    try {
      const metadataBase = {
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        summary: summary.trim(),
        descriptionMd: description,
        tags: selectedTags,
        iconDataUrl: await readDataUrl(icon),
        screenshotDataUrls: await Promise.all(screenshots.slice(0, 5).map(readDataUrl)),
        releaseNotes: notes,
      }
      const metadata = item
        ? { ...metadataBase, smartAppId: item.id, targets: [] }
        : {
            ...metadataBase,
            scope,
            targets: scope === 'restricted' ? targets : [],
          }
      if (installation) {
        const exported = await harnessAppsApi.export(installation.id)
        const initialized = await api.initSubmission(
          {
            filename: `${exported.manifest.name}-${exported.manifest.version}.zip`,
            sha256: exported.sha256,
            sizeBytes: exported.sizeBytes,
          },
          metadata
        )
        try {
          await harnessAppsApi.upload(exported.archivePath, initialized.uploadUrl)
          await api.completeSubmission(initialized.submissionId)
        } catch (value) {
          await api.cancelSubmission(initialized.submissionId).catch(() => undefined)
          throw value
        }
      } else {
        await api.publish(file!, metadata)
      }
      onPublished()
    } catch (value) {
      setError(
        smartAppErrorMessage(
          value,
          t('workbench.smart_apps_publish_failed', '智能工作台发布失败'),
          t('workbench.smart_apps_storage_unavailable', '文件存储服务暂不可用，请稍后重试')
        )
      )
    } finally {
      setPublishing(false)
    }
  }
  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        data-testid="smart-app-publish-dialog"
        className="plugin-dialog-surface max-h-[92vh] w-full max-w-2xl overflow-y-auto p-5"
      >
        <header className="flex justify-between">
          <div>
            <h2 className="heading-small">
              {item
                ? t('workbench.smart_apps_publish_version', '发布新版本')
                : t('workbench.smart_apps_publish_smart_app', '发布智能工作台')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t('workbench.smart_apps_auto_publish_hint', '上传并通过安全扫描后自动发布')}
            </p>
          </div>
          <button
            aria-label={t('common.close', '关闭')}
            data-testid="smart-app-publish-close"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="mt-5 grid gap-4">
          {installation ? (
            <div className="rounded-xl border border-border/40 bg-surface p-3 text-sm">
              <span className="font-medium">
                {t('workbench.smart_apps_publish_installed', '发布已导入工作台')}
              </span>
              <span className="ml-2 text-text-muted">
                {installation.manifest.displayName} · v{installation.manifest.version}
              </span>
            </div>
          ) : (
            <div className="text-sm font-medium">
              <span>{t('workbench.smart_apps_zip', '智能工作台 ZIP')}</span>
              <SmartAppFilePicker
                inputTestId="smart-app-publish-package"
                label={t('workbench.smart_apps_zip', '智能工作台 ZIP')}
                accept=".zip,application/zip"
                files={file ? [file] : []}
                onChange={files => void choosePackage(files[0] ?? null)}
              />
            </div>
          )}
          {manifest ? (
            <div className="rounded-xl bg-surface p-3 text-sm">
              <strong>{manifest.displayName}</strong>
              <span className="ml-2 text-text-muted">
                {manifest.name} · v{manifest.version}
              </span>
            </div>
          ) : null}
          <label className="text-sm font-medium">
            {t('workbench.smart_apps_summary', '一句话简介')}
            <input
              value={summary}
              maxLength={500}
              className="mt-2 h-10 w-full rounded-lg border border-border px-3 font-normal"
              onChange={event => setSummary(event.target.value)}
            />
          </label>
          <label className="text-sm font-medium">
            {t('workbench.smart_apps_description_md', '详细介绍（Markdown）')}
            <textarea
              value={description}
              rows={5}
              className="mt-2 w-full rounded-lg border border-border p-3 font-normal"
              onChange={event => setDescription(event.target.value)}
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium">
              {t('workbench.smart_apps_tags', '市场标签（1–3 个）')}
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {tags.map(tag => (
                <label
                  key={tag.id}
                  className="flex items-center gap-1 rounded-lg border px-2 py-1 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedTags.includes(tag.id)}
                    disabled={!selectedTags.includes(tag.id) && selectedTags.length >= 3}
                    onChange={event =>
                      setSelectedTags(values =>
                        event.target.checked
                          ? [...values, tag.id]
                          : values.filter(value => value !== tag.id)
                      )
                    }
                  />
                  {i18n.language.startsWith('zh') ? tag.name_zh : tag.name_en}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="text-sm font-medium">
            <span>{t('workbench.smart_apps_icon', '方形图标（PNG/WebP）')}</span>
            <SmartAppFilePicker
              inputTestId="smart-app-publish-icon"
              label={t('workbench.smart_apps_icon', '方形图标（PNG/WebP）')}
              accept="image/png,image/webp"
              files={icon ? [icon] : []}
              onChange={files => setIcon(files[0] ?? null)}
            />
          </div>
          <div className="text-sm font-medium">
            <span>{t('workbench.smart_apps_screenshots', '截图（最多 5 张）')}</span>
            <SmartAppFilePicker
              inputTestId="smart-app-publish-screenshots"
              label={t('workbench.smart_apps_screenshots', '截图（最多 5 张）')}
              accept="image/png,image/webp,image/jpeg"
              multiple
              files={screenshots}
              onChange={files => setScreenshots(files.slice(0, 5))}
            />
          </div>
          <label className="text-sm font-medium">
            {t('workbench.smart_apps_release_notes', '版本说明')}
            <textarea
              value={notes}
              rows={3}
              className="mt-2 w-full rounded-lg border border-border p-3 font-normal"
              onChange={event => setNotes(event.target.value)}
            />
          </label>
          {item ? (
            <p className="text-sm text-text-secondary">
              {t(
                'workbench.smart_apps_inherit_access_hint',
                '新版本默认沿用当前分享范围，可发布后在“我的”中调整。'
              )}
            </p>
          ) : (
            <fieldset>
              <legend className="text-sm font-medium">
                {t('workbench.smart_apps_publish_scope', '发布范围')}
              </legend>
              <div className="mt-2 grid grid-cols-2 gap-2 rounded-xl bg-surface p-1">
                <button
                  type="button"
                  className={`h-11 rounded-lg ${scope === 'restricted' ? 'bg-background shadow-sm' : ''}`}
                  onClick={() => setScope('restricted')}
                  data-testid="smart-app-publish-scope-restricted"
                >
                  {t('workbench.smart_apps_restricted', '指定成员/部门')}
                </button>
                <button
                  type="button"
                  className={`h-11 rounded-lg ${scope === 'public' ? 'bg-background shadow-sm' : ''}`}
                  onClick={() => setScope('public')}
                  data-testid="smart-app-publish-scope-public"
                >
                  {t('workbench.smart_apps_public', '全员')}
                </button>
              </div>
              {scope === 'restricted' ? (
                <div className="mt-3">
                  <TargetPicker api={api} targets={targets} onChange={setTargets} />
                </div>
              ) : (
                <p className="mt-3 text-sm text-text-secondary">
                  {t(
                    'workbench.smart_apps_public_hint',
                    '发布成功后立即上架到智能应用市场，所有成员均可查看和安装。'
                  )}
                </p>
              )}
            </fieldset>
          )}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <footer className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel', '取消')}
          </Button>
          <Button disabled={publishing} onClick={() => void publish()}>
            {publishing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('workbench.smart_apps_publishing', '发布中…')}
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                {t('workbench.smart_apps_publish', '发布')}
              </>
            )}
          </Button>
        </footer>
      </section>
    </div>
  )
}
