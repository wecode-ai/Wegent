import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { AlertTriangle, Box, Boxes, Circle, Play, Plus, Square, Trash2, Upload } from 'lucide-react'
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
import { HarnessAppInstallDialog } from '@/features/harness-apps/HarnessAppInstallDialog'
import { Button } from '@/components/ui/button'
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
    try {
      setPreview(await harnessAppsApi.preview(path))
    } catch (previewError) {
      setError(getErrorMessage(previewError, t('workbench.harness_apps_preview_failed')))
    }
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
      setModelKey('')
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

  function stateLabel(item: HarnessAppInstallation) {
    if (item.state === 'running') return t('workbench.harness_apps_state_running', '运行中')
    if (item.state === 'failed') return t('workbench.harness_apps_state_failed', '启动失败')
    return t('workbench.harness_apps_state_installed', '已安装')
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
          <Button
            size="sm"
            data-testid="harness-app-import-button"
            onClick={() => void choosePackage()}
          >
            <Plus className="h-4 w-4" />
            {t('workbench.harness_apps_import', '导入安装包')}
          </Button>
        </header>

        {error ? (
          <div
            data-testid="harness-app-error"
            className="rounded-lg bg-danger/10 p-3 text-sm text-danger"
          >
            {error}
          </div>
        ) : null}

        <section
          data-testid="harness-app-drop-zone"
          className="min-h-0"
          onDragOver={event => event.preventDefault()}
          onDrop={event => void dropPackage(event)}
        >
          {items.length === 0 ? (
            <div
              data-testid="harness-app-empty"
              className="flex min-h-[360px] flex-col items-center justify-center rounded-2xl border border-dashed border-border/45 bg-surface/25 px-8 py-14 text-center"
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/30 bg-background shadow-sm">
                <Boxes className="h-6 w-6 text-text-secondary" />
              </div>
              <strong className="mt-5 text-base font-medium text-text-primary">
                {t('workbench.harness_apps_empty', '尚未安装 Harness 能力')}
              </strong>
              <p className="mt-2 max-w-[420px] text-sm leading-6 text-text-muted">
                {t(
                  'workbench.harness_apps_empty_hint',
                  '导入 DeepSeek Harness 能力包，安装后可以从这里启动，并在独立标签页中使用。'
                )}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-5 rounded-lg"
                onClick={() => void choosePackage()}
              >
                <Upload className="h-4 w-4" />
                {t('workbench.harness_apps_select_package', '选择能力包')}
              </Button>
              <span className="mt-3 text-xs text-text-muted">
                {t('workbench.harness_apps_drop_hint', '也可以将 ZIP 安装包拖到这里')}
              </span>
            </div>
          ) : (
            <div className="grid gap-3">
              {items.map(item => (
                <article
                  key={item.id}
                  data-testid={`harness-app-row-${item.id}`}
                  className="rounded-2xl border border-border/35 bg-surface/25 p-4 transition-colors hover:bg-surface/45"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-background shadow-sm">
                      <Box className="h-5 w-5 text-text-secondary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate font-medium text-text-primary">
                          {item.manifest.displayName}
                        </h2>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-background px-2 py-0.5 text-xs text-text-secondary">
                          <Circle
                            className={`h-2 w-2 fill-current ${
                              item.state === 'running'
                                ? 'text-green-600'
                                : item.state === 'failed'
                                  ? 'text-red-500'
                                  : 'text-text-muted'
                            }`}
                          />
                          {stateLabel(item)}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-1 text-sm text-text-secondary">
                        {item.manifest.description}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                        <span>v{item.manifest.version}</span>
                        <span>
                          {t('workbench.harness_apps_bound_model', '模型')}：
                          {selectedModel(item)?.label ??
                            t('workbench.harness_apps_model_unavailable')}
                        </span>
                      </div>
                      {item.state === 'failed' && item.error ? (
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>{item.error}</span>
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {item.state === 'running' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`harness-app-stop-${item.id}`}
                          className="h-9 gap-1 rounded-lg px-3"
                          disabled={busy === item.id}
                          onClick={() => void stop(item)}
                        >
                          <Square className="h-4 w-4" />
                          {t('workbench.harness_apps_stop', '停止')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          data-testid={`harness-app-start-${item.id}`}
                          className="h-9 gap-1 rounded-lg px-3"
                          disabled={busy === item.id}
                          onClick={() => void start(item)}
                        >
                          <Play className="h-4 w-4" />
                          {t('workbench.harness_apps_open', '打开')}
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        data-testid={`harness-app-delete-${item.id}`}
                        aria-label={t('workbench.harness_apps_delete', '卸载')}
                        className="h-9 w-9 rounded-lg text-text-muted hover:text-red-600"
                        disabled={busy === item.id}
                        onClick={() => void remove(item)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
              <div className="rounded-xl border border-dashed border-border/35 px-4 py-3 text-center text-xs text-text-muted">
                {t('workbench.harness_apps_drop_hint', '也可以将 ZIP 安装包拖到这里')}
              </div>
            </div>
          )}
        </section>
      </div>
      {preview ? (
        <HarnessAppInstallDialog
          busy={busy === 'install'}
          error={error}
          modelKey={installModelKey}
          modelOptions={modelOptions}
          preview={preview}
          onCancel={() => {
            if (busy !== 'install') {
              setPreview(null)
              setError(null)
            }
          }}
          onChooseAnother={() => void choosePackage()}
          onInstall={() => void install()}
          onModelChange={setModelKey}
        />
      ) : null}
    </main>
  )
}
