import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { Box, Loader2, Play, Plus, Square, Trash2 } from 'lucide-react'
import {
  harnessAppsApi,
  type HarnessAppInstallation,
  type HarnessAppPreview,
} from '@/api/local/harnessApps'
import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import {
  listLocalHarnessModelOptions,
  type LocalHarnessModelOption,
} from '@/features/local-harness/localHarnessModels'
import {
  harnessAppRoute,
  registerHarnessAppTab,
  unregisterHarnessAppTab,
} from '@/features/harness-apps/harnessAppTabs'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'

export function HarnessAppsPage() {
  const { t } = useTranslation('common')
  const { projectChat, services } = useWorkbench()
  const workspaceTabs = useOptionalWorkspaceTabs()
  const modelOptions = useMemo(
    () => listLocalHarnessModelOptions('opencode', projectChat.models),
    [projectChat.models]
  )
  const [items, setItems] = useState<HarnessAppInstallation[]>([])
  const [preview, setPreview] = useState<HarnessAppPreview | null>(null)
  const [modelKey, setModelKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const installModelKey = modelKey || modelOptions[0]?.key || ''

  const refresh = async () => setItems(await harnessAppsApi.list())

  function proxyTokenKey(installationId: string) {
    return `wework:harness-app:${installationId}:proxy-token`
  }

  function storeProxyToken(installationId: string, token: string) {
    sessionStorage.setItem(proxyTokenKey(installationId), token)
  }

  function takeProxyToken(installationId: string): string | null {
    const key = proxyTokenKey(installationId)
    const token = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    return token
  }

  function closeAppTabs(installationId: string) {
    if (!workspaceTabs) return
    const route = harnessAppRoute(installationId)
    const mountedTabIds = Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-testid="app-iframe-harness-${CSS.escape(installationId)}"]`
      )
    )
      .map(element => element.dataset.workspaceTabId)
      .filter((tabId): tabId is string => Boolean(tabId))
    const tabIds = new Set([
      ...workspaceTabs.tabs.filter(tab => tab.contentRoute === route).map(tab => tab.id),
      ...mountedTabIds,
    ])
    tabIds.forEach(tabId => workspaceTabs.closeTab(tabId))
  }

  function openAppTab(installation: HarnessAppInstallation) {
    if (!workspaceTabs) return
    const route = harnessAppRoute(installation.id)
    const existing = workspaceTabs.tabs.find(tab => tab.contentRoute === route)
    if (existing) {
      workspaceTabs.selectTab(existing.id, {
        title: installation.manifest.displayName,
        contentRoute: route,
      })
      return
    }
    workspaceTabs.openTab('auxiliary', {
      title: installation.manifest.displayName,
      contentRoute: route,
    })
  }

  useEffect(() => {
    let active = true
    void harnessAppsApi
      .list()
      .then(installations => {
        if (!active) return
        installations
          .filter(installation => installation.state === 'running' && installation.webUrl)
          .forEach(installation => registerHarnessAppTab(installation))
        setItems(installations)
      })
      .catch(loadError => {
        if (active) {
          setError(getErrorMessage(loadError, t('workbench.harness_apps_load_failed')))
        }
      })
    return () => {
      active = false
    }
  }, [t])

  async function previewPackage(path: string) {
    setError(null)
    setPreview(await harnessAppsApi.preview(path))
  }

  async function choosePackage() {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'DeepSeek Harness app', extensions: ['zip'] }],
    })
    if (typeof path !== 'string') return
    await previewPackage(path)
  }

  async function dropPackage(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    const uri = event.dataTransfer.getData('text/uri-list').split(/\r?\n/)[0]?.trim()
    if (!uri) return
    const path = decodeURIComponent(new URL(uri).pathname)
    await previewPackage(path)
  }

  async function install() {
    if (!preview?.valid || !preview.manifest || !installModelKey) return
    setBusy('install')
    setError(null)
    try {
      await harnessAppsApi.install(preview, installModelKey)
      setPreview(null)
      await refresh()
    } catch (installError) {
      setError(getErrorMessage(installError, t('workbench.harness_apps_install_failed')))
    } finally {
      setBusy(null)
    }
  }

  function selectedModel(item: HarnessAppInstallation): LocalHarnessModelOption | null {
    return modelOptions.find(option => option.key === item.modelKey) ?? null
  }

  async function start(item: HarnessAppInstallation) {
    const model = selectedModel(item)
    if (!model) {
      setError(t('workbench.harness_apps_model_missing'))
      return
    }
    setBusy(item.id)
    setError(null)
    let proxyToken: string | null = null
    try {
      const launch = await services.localHarnessModelApi?.resolveLaunch('opencode', model)
      if (!launch) throw new Error(t('workbench.harness_apps_model_proxy_unavailable'))
      proxyToken = launch.proxyToken
      const running = await harnessAppsApi.start(item.id, launch.baseUrl)
      storeProxyToken(item.id, launch.proxyToken)
      await refresh()
      if (running.webUrl) {
        registerHarnessAppTab(running)
        openAppTab(running)
      }
    } catch (startError) {
      if (proxyToken) await services.localHarnessModelApi?.unregisterProxy(proxyToken)
      setError(getErrorMessage(startError, t('workbench.harness_apps_start_failed')))
    } finally {
      setBusy(null)
    }
  }

  async function stop(item: HarnessAppInstallation) {
    setBusy(item.id)
    try {
      await harnessAppsApi.stop(item.id)
      unregisterHarnessAppTab(item.id)
      closeAppTabs(item.id)
      const token = takeProxyToken(item.id)
      if (token) await services.localHarnessModelApi?.unregisterProxy(token)
      await refresh()
    } catch (stopError) {
      setError(getErrorMessage(stopError, t('workbench.harness_apps_stop_failed')))
    } finally {
      setBusy(null)
    }
  }

  async function remove(item: HarnessAppInstallation) {
    if (!window.confirm(t('workbench.harness_apps_delete_confirm', '确定卸载这个能力吗？'))) return
    setBusy(item.id)
    try {
      await stop(item)
      await harnessAppsApi.delete(item.id)
      await refresh()
    } catch (deleteError) {
      setError(getErrorMessage(deleteError, t('workbench.harness_apps_delete_failed')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="h-full overflow-y-auto bg-background text-text-primary">
      <DesktopTopBar testId="harness-apps-topbar" />
      <div className="mx-auto flex max-w-[980px] flex-col gap-5 px-6 py-7">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="heading-base">
              {t('workbench.harness_apps_title', 'DeepSeek Harness 能力')}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                'workbench.harness_apps_description',
                '安装本地 Harness 能力包，并作为独立工作区标签运行。'
              )}
            </p>
          </div>
          <button
            type="button"
            data-testid="harness-app-import-button"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-text-primary px-3 text-sm text-background"
            onClick={() => void choosePackage()}
          >
            <Plus className="h-4 w-4" />
            {t('workbench.harness_apps_import', '导入安装包')}
          </button>
        </header>

        {error ? (
          <div
            data-testid="harness-app-error"
            className="rounded-lg bg-danger/10 p-3 text-sm text-danger"
          >
            {error}
          </div>
        ) : null}

        {preview ? (
          <section
            data-testid="harness-app-preview"
            className="rounded-xl border border-border/50 bg-surface/40 p-4"
          >
            {preview.valid && preview.manifest ? (
              <>
                <h2 className="heading-subsection">{preview.manifest.displayName}</h2>
                <p className="mt-1 text-sm text-text-secondary">{preview.manifest.description}</p>
                <p className="mt-2 text-xs text-text-muted">
                  {preview.manifest.version} · DSH {preview.manifest.requirements.dsh}
                </p>
                <label className="mt-4 block text-sm">
                  <span className="mb-1 block text-text-secondary">
                    {t('workbench.harness_apps_model', '绑定 Wework 模型')}
                  </span>
                  <select
                    data-testid="harness-app-model-select"
                    className="h-9 w-full rounded-lg border border-border bg-background px-3"
                    value={installModelKey}
                    onChange={event => setModelKey(event.target.value)}
                  >
                    <option value="">{t('workbench.harness_apps_model_choose')}</option>
                    {modelOptions.map(option => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  data-testid="harness-app-install-confirm"
                  disabled={busy === 'install' || !installModelKey}
                  className="mt-4 inline-flex h-9 items-center rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50"
                  onClick={() => void install()}
                >
                  {busy === 'install' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {t('workbench.harness_apps_install', '安装')}
                </button>
              </>
            ) : (
              <p className="text-sm text-danger">{preview.issues.join('；')}</p>
            )}
          </section>
        ) : null}

        <section
          data-testid="harness-app-drop-zone"
          className="overflow-hidden rounded-xl border border-border/40"
          onDragOver={event => event.preventDefault()}
          onDrop={event => void dropPackage(event)}
        >
          {items.length === 0 ? (
            <div
              data-testid="harness-app-empty"
              className="p-10 text-center text-sm text-text-muted"
            >
              {t('workbench.harness_apps_empty', '尚未安装 Harness 能力')}
            </div>
          ) : (
            items.map(item => (
              <div
                key={item.id}
                data-testid={`harness-app-row-${item.id}`}
                className="flex items-center gap-3 border-b border-border/30 p-4 last:border-b-0"
              >
                <Box className="h-5 w-5 text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{item.manifest.displayName}</div>
                  <div className="text-xs text-text-muted">
                    {item.manifest.version} · {item.state} ·{' '}
                    {selectedModel(item)?.label ?? t('workbench.harness_apps_model_unavailable')}
                  </div>
                </div>
                {item.state === 'running' ? (
                  <button
                    type="button"
                    data-testid={`harness-app-stop-${item.id}`}
                    className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm hover:bg-muted"
                    onClick={() => void stop(item)}
                  >
                    <Square className="h-4 w-4" />
                    {t('workbench.harness_apps_stop', '停止')}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`harness-app-start-${item.id}`}
                    className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm hover:bg-muted"
                    onClick={() => void start(item)}
                  >
                    <Play className="h-4 w-4" />
                    {t('workbench.harness_apps_open', '打开')}
                  </button>
                )}
                <button
                  type="button"
                  data-testid={`harness-app-delete-${item.id}`}
                  aria-label={t('workbench.harness_apps_delete', '卸载')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted"
                  onClick={() => void remove(item)}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))
          )}
        </section>
      </div>
    </main>
  )
}
