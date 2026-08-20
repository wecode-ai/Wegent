import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  AlertTriangle,
  Box,
  Boxes,
  Circle,
  Pin,
  Play,
  Plus,
  Square,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  harnessAppsApi,
  type HarnessAppInstallation,
  type HarnessAppPreview,
} from '@/api/local/harnessApps'
import { SmartAppsSectionNav } from '@/components/smart-apps/SmartAppsSectionNav'
import {
  listLocalHarnessModelOptions,
  type LocalHarnessModelOption,
} from '@/features/local-harness/localHarnessModels'
import {
  harnessAppRoute,
  openHarnessAppTab,
  registerHarnessAppTab,
  storeHarnessAppProxyToken,
  storeHarnessAppContextToken,
  takeHarnessAppContextToken,
  takeHarnessAppProxyToken,
  unregisterHarnessAppTab,
} from '@/features/harness-apps/harnessAppTabs'
import {
  beginHarnessAppLaunch,
  clearHarnessAppLaunch,
  failHarnessAppLaunch,
} from '@/features/harness-apps/harnessAppLaunchState'
import { HarnessAppInstallDialog } from '@/features/harness-apps/HarnessAppInstallDialog'
import { Button } from '@/components/ui/button'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { navigateTo } from '@/lib/navigation'

interface HarnessAppsPageProps {
  importRequested?: boolean
}

export function HarnessAppsPage({ importRequested = false }: HarnessAppsPageProps) {
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
  const importHandled = useRef(false)
  const installModelKey = modelKey || modelOptions[0]?.key || ''

  const refresh = async () => setItems(await harnessAppsApi.list())

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

  const previewPackage = useCallback(
    async (path: string) => {
      setError(null)
      setPreview(null)
      try {
        setPreview(await harnessAppsApi.preview(path))
      } catch (previewError) {
        setError(getErrorMessage(previewError, t('workbench.harness_apps_preview_failed')))
      }
    },
    [t]
  )

  const choosePackage = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: t('workbench.smart_apps_package', '智能应用安装包'), extensions: ['zip'] }],
    })
    if (typeof path !== 'string') return
    await previewPackage(path)
  }, [previewPackage, t])

  useEffect(() => {
    if (!importRequested || importHandled.current) return
    importHandled.current = true
    navigateTo('/sites?app_type=smart_app&view=installed')
    void choosePackage()
  }, [choosePackage, importRequested])

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
    beginHarnessAppLaunch(item.id, item.manifest.displayName, () => void start(item))
    if (workspaceTabs) openHarnessAppTab(workspaceTabs, item)
    setBusy(item.id)
    setError(null)
    let proxyToken: string | null = null
    let contextToken: string | null = null
    let started = false
    try {
      const launch = await services.localHarnessModelApi?.resolveLaunch('opencode', model)
      if (!launch) throw new Error(t('workbench.harness_apps_model_proxy_unavailable'))
      proxyToken = launch.proxyToken
      contextToken = launch.context?.token ?? null
      const running = launch.context
        ? await harnessAppsApi.start(
            item.id,
            launch.baseUrl,
            launch.context.baseUrl,
            launch.context.token
          )
        : await harnessAppsApi.start(item.id, launch.baseUrl)
      started = true
      await storeHarnessAppProxyToken(item.id, launch.proxyToken)
      if (contextToken) await storeHarnessAppContextToken(item.id, contextToken)
      await refresh()
      if (running.webUrl) {
        registerHarnessAppTab(running)
        clearHarnessAppLaunch(item.id)
      }
    } catch (startError) {
      let proxyCanBeRevoked = !started
      if (started) {
        try {
          await harnessAppsApi.stop(item.id)
          proxyCanBeRevoked = true
        } catch (rollbackError) {
          console.warn('[Wework] failed to roll back started Harness app', rollbackError)
          try {
            const installations = await harnessAppsApi.list()
            const running = installations.find(installation => installation.id === item.id)
            if (running?.state === 'running' && running.webUrl) {
              registerHarnessAppTab(running)
              clearHarnessAppLaunch(item.id)
            }
            setItems(installations)
          } catch (recoveryError) {
            console.warn('[Wework] failed to recover running Harness app', recoveryError)
          }
        }
        if (proxyCanBeRevoked) {
          unregisterHarnessAppTab(item.id)
          await takeHarnessAppProxyToken(item.id)
          await takeHarnessAppContextToken(item.id)
          try {
            await refresh()
          } catch (refreshError) {
            console.warn('[Wework] failed to refresh Harness apps after rollback', refreshError)
          }
        }
      }
      if (proxyToken && proxyCanBeRevoked) {
        try {
          await services.localHarnessModelApi?.unregisterProxy(proxyToken)
        } catch (proxyError) {
          console.warn('[Wework] failed to unregister Harness model proxy', proxyError)
        }
      }
      const message = getErrorMessage(startError, t('workbench.harness_apps_start_failed'))
      failHarnessAppLaunch(item.id, message)
      setError(message)
      if (contextToken && proxyCanBeRevoked) {
        try {
          await services.localHarnessModelApi?.unregisterContext(contextToken)
        } catch (contextError) {
          console.warn('[Wework] failed to unregister Harness context', contextError)
        }
      }
    } finally {
      setBusy(null)
    }
  }

  async function stop(item: HarnessAppInstallation) {
    setBusy(item.id)
    try {
      await harnessAppsApi.stop(item.id)
      unregisterHarnessAppTab(item.id)
      clearHarnessAppLaunch(item.id)
      closeAppTabs(item.id)
      const token = await takeHarnessAppProxyToken(item.id)
      if (token) await services.localHarnessModelApi?.unregisterProxy(token)
      const contextToken = await takeHarnessAppContextToken(item.id)
      if (contextToken) await services.localHarnessModelApi?.unregisterContext(contextToken)
      await refresh()
    } catch (stopError) {
      setError(getErrorMessage(stopError, t('workbench.harness_apps_stop_failed')))
    } finally {
      setBusy(null)
    }
  }

  async function remove(item: HarnessAppInstallation) {
    if (!window.confirm(t('workbench.harness_apps_delete_confirm', '确定卸载这个智能应用吗？')))
      return
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

  async function changeModel(item: HarnessAppInstallation, nextModelKey: string) {
    if (!nextModelKey || nextModelKey === item.modelKey) return
    if (item.state === 'running') {
      setError(t('workbench.smart_apps_model_change_stop_first'))
      return
    }
    setBusy(item.id)
    setError(null)
    try {
      await harnessAppsApi.update(item.id, { modelKey: nextModelKey })
      await refresh()
    } catch (updateError) {
      setError(getErrorMessage(updateError, t('workbench.smart_apps_model_change_failed')))
    } finally {
      setBusy(null)
    }
  }

  async function toggleResident(item: HarnessAppInstallation) {
    setBusy(item.id)
    setError(null)
    try {
      await harnessAppsApi.update(item.id, { resident: !item.resident })
      await refresh()
    } catch (updateError) {
      setError(getErrorMessage(updateError, t('workbench.smart_apps_resident_update_failed')))
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
    <section className="flex min-w-0 w-full flex-col">
      <SmartAppsSectionNav active="installed" />
      <header className="mt-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="heading-base">
            {t('workbench.smart_apps_installed_title', '已安装智能应用')}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t(
              'workbench.harness_apps_description',
              '安装本地智能应用，并作为独立工作区标签运行。'
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
          className="mt-5 rounded-lg bg-danger/10 p-3 text-sm text-danger"
        >
          {error}
        </div>
      ) : null}

      <section
        data-testid="harness-app-drop-zone"
        className="mt-5 min-h-0"
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
              {t('workbench.harness_apps_empty', '尚未安装智能应用')}
            </strong>
            <p className="mt-2 max-w-[420px] text-sm leading-6 text-text-muted">
              {t(
                'workbench.harness_apps_empty_hint',
                '导入智能应用安装包，安装后可以从这里启动，并在独立标签页中使用。'
              )}
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="harness-app-empty-select-package"
              className="mt-5 rounded-lg"
              onClick={() => void choosePackage()}
            >
              <Upload className="h-4 w-4" />
              {t('workbench.harness_apps_select_package', '选择安装包')}
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
                      <label className="flex items-center gap-1">
                        {t('workbench.harness_apps_bound_model', '模型')}：
                        <select
                          data-testid={`harness-app-model-${item.id}`}
                          aria-label={t('workbench.smart_apps_change_model', '修改模型')}
                          className="max-w-48 rounded-md border border-border/50 bg-background px-1.5 py-0.5 text-xs text-text-secondary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15 disabled:cursor-not-allowed disabled:opacity-60"
                          value={item.modelKey ?? ''}
                          disabled={busy === item.id || item.state === 'running'}
                          title={
                            item.state === 'running'
                              ? t('workbench.smart_apps_model_change_stop_first')
                              : undefined
                          }
                          onChange={event => void changeModel(item, event.target.value)}
                        >
                          {modelOptions.map(option => (
                            <option key={option.key} value={option.key}>
                              {option.label}
                            </option>
                          ))}
                          {!selectedModel(item) ? (
                            <option value={item.modelKey ?? ''}>
                              {t('workbench.harness_apps_model_unavailable')}
                            </option>
                          ) : null}
                        </select>
                      </label>
                    </div>
                    {item.state === 'failed' && item.error ? (
                      <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{item.error}</span>
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant={item.resident ? 'secondary' : 'ghost'}
                      data-testid={`harness-app-resident-${item.id}`}
                      aria-pressed={item.resident}
                      title={t(
                        'workbench.smart_apps_resident_description',
                        'Wework 启动时自动打开'
                      )}
                      className="h-11 gap-1 rounded-lg px-2.5 sm:h-9"
                      disabled={busy === item.id}
                      onClick={() => void toggleResident(item)}
                    >
                      <Pin className={item.resident ? 'fill-current' : undefined} />
                      {t('workbench.smart_apps_resident', '常驻')}
                    </Button>
                    {item.state === 'running' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`harness-app-stop-${item.id}`}
                        className="h-11 gap-1 rounded-lg px-3 sm:h-9"
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
                        className="h-11 gap-1 rounded-lg px-3 sm:h-9"
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
                      className="h-11 w-11 rounded-lg text-text-muted hover:text-red-600 sm:h-9 sm:w-9"
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
    </section>
  )
}
