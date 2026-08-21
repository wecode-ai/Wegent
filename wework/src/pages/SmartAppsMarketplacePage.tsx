import { useCallback, useEffect, useMemo, useState } from 'react'
import JSZip from 'jszip'
import {
  Boxes,
  CheckCircle2,
  Download,
  Loader2,
  PackageCheck,
  Search,
  Share2,
  ShieldCheck,
  Upload,
  WandSparkles,
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
import {
  harnessAppsApi,
  type HarnessAppInstallation,
  type HarnessAppManifest,
  type HarnessAppPreview,
} from '@/api/local/harnessApps'
import { SmartAppsSectionNav } from '@/components/smart-apps/SmartAppsSectionNav'
import { Button } from '@/components/ui/button'
import { HarnessAppInstallDialog } from '@/features/harness-apps/HarnessAppInstallDialog'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import { queuePluginReferenceTrial } from '@/features/plugins/pluginTrial'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { navigateTo } from '@/lib/navigation'
import { ensureBundledPluginInstalled } from '@/tauri/localExecutor'

interface SmartAppsMarketplacePageProps {
  api: SmartAppsApi | null
  mode?: 'marketplace' | 'owned'
}

interface PendingInstall {
  item: SmartAppMarketplaceItem
  preview: HarnessAppPreview
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
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
}: SmartAppsMarketplacePageProps) {
  const { t, i18n } = useTranslation('common')
  const { projectChat } = useWorkbench()
  const modelOptions = useMemo(
    () => listLocalHarnessModelOptions('opencode', projectChat.models),
    [projectChat.models]
  )
  const [items, setItems] = useState<SmartAppMarketplaceItem[]>([])
  const [installed, setInstalled] = useState<HarnessAppInstallation[]>([])
  const [tags, setTags] = useState<SmartAppMarketplaceTag[]>([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'official' | 'shared'>('all')
  const [tag, setTag] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
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
  const installModelKey = modelKey || modelOptions[0]?.key || ''

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const localPromise = harnessAppsApi.list().catch(() => [])
      if (!api) {
        setItems([])
        setInstalled(await localPromise)
        return
      }
      const [catalog, local, tagCatalog] = await Promise.all([
        mode === 'owned'
          ? api.listOwned()
          : api.listMarketplace({
              q: query,
              source: source === 'all' ? undefined : source,
              tag: tag || undefined,
            }),
        localPromise,
        api.listTags().catch(() => ({ version: 0, items: [] })),
      ])
      setItems(catalog.items)
      setInstalled(local)
      setTags(tagCatalog.items.filter(item => item.enabled).sort((a, b) => a.sort - b.sort))
    } catch (loadError) {
      setError(
        getErrorMessage(
          loadError,
          t('workbench.smart_apps_marketplace_load_failed', '智能应用市场加载失败')
        )
      )
    } finally {
      setLoading(false)
    }
  }, [api, mode, query, source, t, tag])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), query ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [refresh, query])

  useEffect(() => {
    if (mode !== 'owned' || publishRequestHandled) return
    const params = new URLSearchParams(window.location.search)
    const installationId = params.get('installationId')
    if (params.get('action') !== 'publish' || !installationId) return
    const installation = installed.find(item => item.id === installationId)
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
  }, [installed, items, mode, publishRequestHandled])

  function localState(item: SmartAppMarketplaceItem) {
    const installation = installed.find(candidate => candidate.smartAppId === item.id)
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
        getErrorMessage(
          downloadError,
          t('workbench.smart_apps_download_failed', '智能应用下载失败')
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
      if (
        window.confirm(
          t(
            'workbench.smart_apps_update_go_installed_confirm',
            '应用正在运行，是否前往“已安装”停止后更新？'
          )
        )
      ) {
        navigateTo('/sites?app_type=smart_app&view=installed')
      }
      return
    }
    setBusy('install')
    setError(null)
    try {
      await harnessAppsApi.install(pendingInstall.preview, installModelKey, {
        smartAppId: pendingInstall.item.id,
        releaseId: pendingInstall.item.latestReleaseId,
      })
      setPendingInstall(null)
      setModelKey('')
      await refresh()
      navigateTo('/sites?app_type=smart_app&view=installed&notice=installed')
    } catch (installError) {
      setError(
        getErrorMessage(
          installError,
          t('workbench.smart_apps_install_failed_keep_old', '智能应用安装失败，原版本已保留')
        )
      )
    } finally {
      setBusy(null)
    }
  }

  async function createSmartApp() {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      await ensureBundledPluginInstalled('smart-app-builder')
      const queued = queuePluginReferenceTrial({
        pluginName: 'smart-app-builder',
        marketplaceName: 'wework-personal',
        displayName: t('workbench.smart_apps_builder_name', '智能应用开发助手'),
        prompt: t(
          'workbench.smart_apps_builder_prompt',
          '帮我创建一个智能应用，完成 DSH 环境准备、插件检索与拼装、内置浏览器测试、打包和本机安装。'
        ),
        openInNewChat: true,
      })
      if (!queued) throw new Error('Smart App Builder reference could not be queued')
      navigateTo('/')
    } catch (createError) {
      setError(
        getErrorMessage(
          createError,
          t('workbench.smart_apps_builder_install_failed', '智能应用开发助手安装失败，请重试。')
        )
      )
    } finally {
      setCreating(false)
    }
  }

  return (
    <section
      data-testid={mode === 'owned' ? 'smart-apps-owned-page' : 'smart-apps-marketplace-page'}
    >
      <SmartAppsSectionNav active={mode === 'owned' ? 'owned' : 'marketplace'} />
      <header className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="heading-base">
            {mode === 'owned'
              ? t('workbench.smart_apps_owned', '我的发布')
              : t('workbench.smart_apps_marketplace_title', '智能应用市场')}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {mode === 'owned'
              ? t(
                  'workbench.smart_apps_owned_description',
                  '管理自己发布的应用、分享范围和历史版本。'
                )
              : t(
                  'workbench.smart_apps_marketplace_description',
                  '发现官方应用，以及成员定向分享给你的应用。'
                )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="smart-apps-marketplace-create"
            onClick={() => void createSmartApp()}
          >
            <WandSparkles className="h-4 w-4" />
            {creating
              ? t('workbench.smart_apps_preparing', '正在准备…')
              : t('workbench.smart_apps_create', '创建应用')}
          </Button>
          <Button
            size="sm"
            data-testid="smart-apps-publish-button"
            disabled={!api}
            onClick={() => {
              setPublishInstallation(null)
              setPublishItem(null)
            }}
          >
            <Upload className="h-4 w-4" />
            {t('workbench.smart_apps_publish_app', '发布应用')}
          </Button>
        </div>
      </header>

      {mode === 'marketplace' ? (
        <div className="mt-5 flex flex-wrap gap-2">
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
            <input
              data-testid="smart-apps-marketplace-search"
              value={query}
              placeholder={t('workbench.smart_apps_search', '搜索应用')}
              className="h-9 w-full rounded-lg border border-border/50 bg-background pl-9 pr-3 text-sm outline-none focus:border-focus"
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          <select
            data-testid="smart-apps-marketplace-source"
            value={source}
            className="h-9 rounded-lg border border-border/50 bg-background px-3 text-sm"
            onChange={event => setSource(event.target.value as typeof source)}
          >
            <option value="all">{t('workbench.smart_apps_source_all', '全部来源')}</option>
            <option value="official">
              {t('workbench.smart_apps_source_official', '官方应用')}
            </option>
            <option value="shared">{t('workbench.smart_apps_source_shared', '分享给我')}</option>
          </select>
          <select
            data-testid="smart-apps-marketplace-tag"
            value={tag}
            className="h-9 rounded-lg border border-border/50 bg-background px-3 text-sm"
            onChange={event => setTag(event.target.value)}
          >
            <option value="">{t('workbench.smart_apps_tag_all', '全部标签')}</option>
            {tags.map(item => (
              <option key={item.id} value={item.id}>
                {i18n.language.startsWith('zh') ? item.name_zh : item.name_en}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 rounded-lg bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {!api ? (
        <EmptyState
          icon={<Boxes className="h-6 w-6" />}
          title={t('workbench.smart_apps_cloud_required', '连接云端后使用智能应用市场')}
          description={t(
            'workbench.smart_apps_cloud_required_hint',
            '本地已安装应用不受影响，仍可离线管理和运行。'
          )}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigateTo('/sites?app_type=smart_app&view=installed')}
            >
              <PackageCheck className="h-4 w-4" />
              {t('workbench.smart_apps_view_installed', '查看已安装')}
            </Button>
          }
        />
      ) : loading ? (
        <div className="flex min-h-72 items-center justify-center text-text-muted">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {t('workbench.smart_apps_loading', '正在加载')}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-6 w-6" />}
          title={
            mode === 'owned'
              ? t('workbench.smart_apps_owned_empty', '还没有发布智能应用')
              : t('workbench.smart_apps_marketplace_empty', '没有找到智能应用')
          }
          description={
            mode === 'owned'
              ? t(
                  'workbench.smart_apps_owned_empty_hint',
                  '选择一个本地 ZIP 包，设置市场信息并分享给成员或部门。'
                )
              : t(
                  'workbench.smart_apps_marketplace_empty_hint',
                  '可以调整搜索条件，或稍后再来看看。'
                )
          }
        />
      ) : (
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map(item => {
            const state = localState(item)
            return (
              <article
                key={item.id}
                data-testid={`smart-app-marketplace-item-${item.id}`}
                className="flex flex-col rounded-2xl border border-border/35 bg-surface/25 p-4 hover:bg-surface/45"
              >
                <button
                  className="flex flex-1 items-start gap-3 text-left"
                  onClick={() => setSelected(item)}
                >
                  {item.iconUrl ? (
                    <img src={item.iconUrl} alt="" className="h-12 w-12 rounded-xl object-cover" />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-background">
                      <Boxes className="h-5 w-5" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate font-medium">{item.displayName}</h2>
                      <span className="rounded-md bg-background px-1.5 py-0.5 text-xs text-text-muted">
                        {item.sourceType === 'official'
                          ? t('workbench.smart_apps_official', '官方')
                          : item.ownerDisplayName}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm leading-5 text-text-secondary">
                      {item.summary}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {item.tags.map(value => (
                        <span
                          key={value}
                          className="rounded-md bg-background px-1.5 py-0.5 text-xs text-text-muted"
                        >
                          {value}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
                <div className="mt-4 flex items-center justify-between border-t border-border/25 pt-3">
                  <span className="text-xs text-text-muted">
                    v{item.version} · {formatBytes(item.sizeBytes)}
                  </span>
                  <div className="flex gap-1">
                    {mode === 'owned' ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setShareItem(item)}>
                          <Share2 className="h-4 w-4" />
                          {t('workbench.smart_apps_share', '分享')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPublishItem(item)}>
                          {t('workbench.smart_apps_publish_version', '发布新版本')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        data-testid={`smart-app-marketplace-install-${item.id}`}
                        variant={state && !state.update ? 'outline' : 'default'}
                        disabled={busy === `download-${item.id}` || Boolean(state && !state.update)}
                        onClick={() => void download(item)}
                      >
                        {busy === `download-${item.id}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4" />
                        )}
                        {state
                          ? state.update
                            ? t('workbench.smart_apps_update', '更新')
                            : t('workbench.smart_apps_installed', '已安装')
                          : t('workbench.harness_apps_install', '安装')}
                      </Button>
                    )}
                  </div>
                </div>
              </article>
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
          onChooseAnother={() => setPendingInstall(null)}
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
          onSaved={() => {
            setShareItem(null)
            void refresh()
          }}
        />
      ) : null}
    </section>
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
    <div className="mt-5 flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-dashed border-border/45 bg-surface/25 px-8 text-center">
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
  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        data-testid="smart-app-details"
        className="plugin-dialog-surface max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6"
      >
        <header className="flex items-start gap-4">
          {item.iconUrl ? (
            <img src={item.iconUrl} alt="" className="h-16 w-16 rounded-2xl object-cover" />
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="heading-small">{item.displayName}</h2>
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
            aria-label={t('common.close', '关闭')}
            className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-surface"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="mt-5 flex flex-wrap gap-3 rounded-xl bg-surface p-3 text-xs text-text-secondary">
          <span className="flex items-center gap-1">
            <ShieldCheck className="h-4 w-4 text-green-600" />
            {t('workbench.smart_apps_scan_passed', '安全扫描通过')}
          </span>
          <span>{formatBytes(item.sizeBytes)}</span>
          <span>
            {t('workbench.smart_apps_updated_at', '更新于 {{date}}').replace(
              '{{date}}',
              new Date(item.updatedAt).toLocaleDateString()
            )}
          </span>
        </div>
        {item.screenshotUrls.length ? (
          <div className="mt-5 flex gap-3 overflow-x-auto">
            {item.screenshotUrls.map(url => (
              <img
                key={url}
                src={url}
                alt={t('workbench.smart_apps_screenshot', '应用截图')}
                className="h-44 rounded-xl border object-cover"
              />
            ))}
          </div>
        ) : null}
        <div className="prose prose-sm mt-5 max-w-none text-text-secondary">
          <ReactMarkdown>{item.descriptionMd || item.summary}</ReactMarkdown>
        </div>
        {item.releaseNotes ? (
          <div className="mt-5">
            <h3 className="text-sm font-medium">
              {t('workbench.smart_apps_release_notes', '版本说明')}
            </h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">
              {item.releaseNotes}
            </p>
          </div>
        ) : null}
        <footer className="mt-6 flex justify-end">
          <Button disabled={busy || Boolean(state && !state.update)} onClick={onInstall}>
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
  onSaved: () => void
}) {
  const { t } = useTranslation('common')
  const [access, setAccess] = useState<SmartAppAccess | null>(null)
  const [scope, setScope] = useState<'private' | 'restricted'>('restricted')
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
      await api.updateAccess(item.id, { scope, targets: scope === 'restricted' ? targets : [] })
      onSaved()
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
          <button aria-label={t('common.close', '关闭')} onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>
        {access ? (
          <>
            <div className="mt-5 grid grid-cols-2 gap-2 rounded-xl bg-surface p-1">
              <button
                type="button"
                className={`h-10 rounded-lg ${scope === 'private' ? 'bg-background shadow-sm' : ''}`}
                onClick={() => setScope('private')}
              >
                {t('workbench.smart_apps_private', '仅自己')}
              </button>
              <button
                type="button"
                className={`h-10 rounded-lg ${scope === 'restricted' ? 'bg-background shadow-sm' : ''}`}
                onClick={() => setScope('restricted')}
              >
                {t('workbench.smart_apps_restricted', '指定成员/部门')}
              </button>
            </div>
            {scope === 'restricted' ? (
              <div className="mt-4">
                <TargetPicker api={api} targets={targets} onChange={setTargets} />
              </div>
            ) : (
              <p className="mt-4 text-sm text-text-secondary">
                {t(
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
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel', '取消')}
          </Button>
          <Button disabled={!access || saving} onClick={() => void save()}>
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
  const [summary, setSummary] = useState(item?.summary ?? '')
  const [description, setDescription] = useState(item?.descriptionMd ?? '')
  const [selectedTags, setSelectedTags] = useState<string[]>(item?.tags ?? [])
  const [icon, setIcon] = useState<File | null>(null)
  const [screenshots, setScreenshots] = useState<File[]>([])
  const [notes, setNotes] = useState('')
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
        invalidPackage: t('workbench.smart_apps_invalid_package', '不是有效的智能应用安装包'),
      })
      if (item && parsed.name !== item.name) {
        throw new Error(
          t('workbench.smart_apps_version_name_mismatch', '新版本的应用名称必须与原应用一致')
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
    if (!item && !targets.length) {
      setError(
        t('workbench.smart_apps_first_target_required', '首次发布必须选择至少一个成员或部门')
      )
      return
    }
    setPublishing(true)
    setError(null)
    try {
      const metadata = {
        smartAppId: item?.id,
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        summary: summary.trim(),
        descriptionMd: description,
        tags: selectedTags,
        iconDataUrl: await readDataUrl(icon),
        screenshotDataUrls: await Promise.all(screenshots.slice(0, 5).map(readDataUrl)),
        releaseNotes: notes,
        targets,
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
      setError(getErrorMessage(value, t('workbench.smart_apps_publish_failed', '智能应用发布失败')))
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
                : t('workbench.smart_apps_publish_smart_app', '发布智能应用')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t('workbench.smart_apps_auto_publish_hint', '上传并通过安全扫描后自动发布')}
            </p>
          </div>
          <button aria-label={t('common.close', '关闭')} onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="mt-5 grid gap-4">
          {installation ? (
            <div className="rounded-xl border border-border/40 bg-surface p-3 text-sm">
              <span className="font-medium">
                {t('workbench.smart_apps_publish_installed', '从已安装应用发布')}
              </span>
              <span className="ml-2 text-text-muted">
                {installation.manifest.displayName} · v{installation.manifest.version}
              </span>
            </div>
          ) : (
            <label className="text-sm font-medium">
              {t('workbench.smart_apps_zip', '智能应用 ZIP')}
              <input
                data-testid="smart-app-publish-package"
                type="file"
                accept=".zip,application/zip"
                className="mt-2 block w-full text-sm"
                onChange={event => void choosePackage(event.target.files?.[0] ?? null)}
              />
            </label>
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
          <label className="text-sm font-medium">
            {t('workbench.smart_apps_icon', '方形图标（PNG/WebP）')}
            <input
              type="file"
              accept="image/png,image/webp"
              className="mt-2 block w-full text-sm"
              onChange={event => setIcon(event.target.files?.[0] ?? null)}
            />
          </label>
          <label className="text-sm font-medium">
            {t('workbench.smart_apps_screenshots', '截图（最多 5 张）')}
            <input
              type="file"
              multiple
              accept="image/png,image/webp,image/jpeg"
              className="mt-2 block w-full text-sm"
              onChange={event => setScreenshots(Array.from(event.target.files ?? []).slice(0, 5))}
            />
          </label>
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
                '新版本默认沿用当前分享范围，可发布后在“我的发布”中调整。'
              )}
            </p>
          ) : (
            <fieldset>
              <legend className="text-sm font-medium">
                {t('workbench.smart_apps_targets_required', '分享对象（必选）')}
              </legend>
              <div className="mt-2">
                <TargetPicker api={api} targets={targets} onChange={setTargets} />
              </div>
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
