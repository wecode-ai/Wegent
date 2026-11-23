import type { PendingInstall } from './smartAppsMarketplaceTypes'
import type { createMarketplacePageSource } from './marketplacePageSource'
import { type DragEvent } from 'react'
import {
  Boxes,
  Code2,
  Copy,
  FolderOpen,
  PackageOpen,
  Settings2,
  Share2,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react'
import type { SmartAppMarketplaceItem, SmartAppsApi } from '@/api/smartApps'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import { type ActionMenuItem } from '@/components/common/ActionMenu'
import { type SmartAppDevelopmentInput } from '@/features/harness-apps/SmartAppDevelopmentDialog'
import { notifyHarnessAppInstallationsChanged } from '@/features/harness-apps/harnessAppInstallationsChanged'
import {
  importSmartAppPackage,
  installMarketplaceSmartApp,
  prepareMarketplaceSmartApp,
} from '@/features/harness-apps/smartAppOperations'
import { queueSmartAppDevelopmentPreview } from '@/features/harness-apps/smartAppDevelopmentPreview'
import type { useHarnessAppManagement } from '@/features/harness-apps/useHarnessAppManagement'
import { queuePluginReferenceTrial } from '@/features/plugins/pluginTrial'
import type { useTranslation } from '@/hooks/useTranslation'
import { getLocalExecutorDeviceId, revealLocalFile } from '@/lib/local-terminal'
import { navigateTo } from '@/lib/navigation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'
import { fileUrlToPath } from '@/lib/workspace-path-transfer'
import { ensureBundledPluginInstalled } from '@/desktop/localExecutor'
import type { useSmartAppCatalog } from './useSmartAppCatalog'
import type { MarketplacePageSnapshot } from './marketplacePageSource'
interface MarketplaceOperationsInput {
  pageView: ReturnType<ReturnType<typeof createMarketplacePageSource>['observe']>
  pageState: MarketplacePageSnapshot
  catalog: Pick<
    ReturnType<typeof useSmartAppCatalog>,
    | 'refresh'
    | 'invalidateRefresh'
    | 'readLocalInstallations'
    | 'marketItems'
    | 'setError'
    | 'localReady'
  >
  management: Pick<ReturnType<typeof useHarnessAppManagement>, 'stop'>
  t: ReturnType<typeof useTranslation>['t']
  api: SmartAppsApi | null
  mode: 'marketplace' | 'owned'
  currentPendingInstall: PendingInstall | null
  installModelKey: string
  requestConfirmation(message: string): Promise<boolean>
  navigateFromSmartApps(path: string): void
}
export function createMarketplaceOperations({
  pageView,
  pageState,
  catalog,
  management,
  t,
  api,
  mode,
  currentPendingInstall,
  installModelKey,
  requestConfirmation,
  navigateFromSmartApps,
}: MarketplaceOperationsInput) {
  const { busy, copyInstallation, pendingDelete, pluginInstallation } = pageState
  const {
    setBusy,
    setExportNotice,
    setSelected,
    setPendingInstall,
    setModelKey,
    setShareItem,
    setCreating,
    setCreateError,
    setDevelopmentDialog,
    setCopyInstallation,
    setImporting,
    setPendingDelete,
    setPluginInstallation,
  } = pageView
  const { refresh, invalidateRefresh, readLocalInstallations, marketItems, setError, localReady } =
    catalog
  const { stop: stopInstalledApp } = management
  function currentInstallation(installation: HarnessAppInstallation) {
    return readLocalInstallations()?.find(candidate => candidate.id === installation.id)
  }

  function requireCurrentInstallation(installation: HarnessAppInstallation) {
    const current = currentInstallation(installation)
    if (!current) {
      throw new Error(
        t('workbench.smart_apps_local_state_unavailable', '请等待本机工作台列表加载完成后重试。')
      )
    }
    return current
  }

  function withCurrentInstallation(
    installation: HarnessAppInstallation,
    action: (current: HarnessAppInstallation) => unknown
  ) {
    const current = currentInstallation(installation)
    if (current) void action(current)
  }

  async function download(item: SmartAppMarketplaceItem) {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    const installations = readLocalInstallations()
    if (!api || !installations) return
    const current = installations.find(candidate => candidate.smartAppId === item.id)
    const intent = current && current.releaseId !== item.latestReleaseId ? 'update' : 'install'
    const isCurrentDownload = pageView.beginDownload()
    setBusy(`download-${item.id}`)
    setError(null)
    try {
      const preparation = await prepareMarketplaceSmartApp(api, item, intent)
      if (!isCurrentDownload()) return
      const latest = readLocalInstallations()
      if (!latest) return
      setPendingInstall({ ...preparation, readInstallations: readLocalInstallations })
      setModelKey(latest.find(candidate => candidate.smartAppId === item.id)?.modelKey ?? '')
      setSelected(null)
    } catch (downloadError) {
      if (!isCurrentDownload()) return
      if (!isCurrent()) return
      setError(
        getSmartAppErrorMessage(
          downloadError,
          t('workbench.smart_apps_download_failed', '智能工作台下载失败'),
          t
        )
      )
    } finally {
      if (isCurrentDownload()) setBusy(null)
    }
  }

  async function install() {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    const installations = readLocalInstallations()
    if (!currentPendingInstall || !installModelKey || !installations) return
    const current = installations.find(
      candidate => candidate.smartAppId === currentPendingInstall.item.id
    )
    const isCurrentInstall = pageView.beginInstall()
    if (current?.state === 'running') {
      const shouldStop = await requestConfirmation(
        t('workbench.smart_apps_update_stop_confirm', '更新需要先停止正在运行的工作台，是否继续？')
      )
      if (!shouldStop || !(await stopInstalledApp(current, false))) return
      if (!isCurrentInstall()) return
    }
    if (!readLocalInstallations()) return
    setBusy('install')
    setError(null)
    try {
      await installMarketplaceSmartApp(currentPendingInstall, installModelKey)
      if (!isCurrentInstall()) return
      setPendingInstall(null)
      setModelKey('')
      if (!isCurrent()) return
      await refresh()
    } catch (installError) {
      if (!isCurrentInstall()) return
      if (!isCurrent()) return
      setError(
        getSmartAppErrorMessage(
          installError,
          t('workbench.smart_apps_install_failed_keep_old', '智能工作台安装失败，原版本已保留'),
          t
        )
      )
    } finally {
      if (isCurrentInstall()) setBusy(null)
    }
  }

  async function openBuilder(
    installation: HarnessAppInstallation,
    intent: 'develop' | 'created',
    targetWorkspace?: { deviceId: string; path: string }
  ) {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

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
      if (!isCurrent()) return
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
      if (!isCurrent()) return
      setCreateError(
        t('workbench.smart_apps_builder_install_failed', '智能工作台开发助手安装失败，请重试。')
      )
    }
  }

  async function addPluginToInstallation(pluginSpec: string) {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    if (!pluginInstallation) return
    const current = requireCurrentInstallation(pluginInstallation)
    if (current.state === 'running') {
      const stopped = await stopInstalledApp(current, false)
      if (!stopped) throw new Error(t('workbench.harness_apps_stop_failed', '停止智能工作台失败。'))
    }
    if (!isCurrent()) return
    requireCurrentInstallation(current)
    await harnessAppsApi.addPlugin(current.id, pluginSpec)
    if (!isCurrent()) return
    await refresh()
  }

  async function createSmartApp(input: SmartAppDevelopmentInput) {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    setCreating(true)
    setCreateError(null)
    try {
      const localDeviceId = await getLocalExecutorDeviceId()
      if (!isCurrent()) return
      if (!localDeviceId) {
        throw new Error(t('workbench.no_local_project_device', '暂无可用本地设备'))
      }
      const installation = await harnessAppsApi.createDirectory(input)
      notifyHarnessAppInstallationsChanged({
        type: 'installed',
        installationId: installation.id,
        installation,
      })
      if (!isCurrent()) return
      await refresh()
      if (!isCurrent()) return
      await openBuilder(installation, 'created', {
        deviceId: localDeviceId,
        path: installation.packagePath,
      })
    } finally {
      if (isCurrent()) setCreating(false)
    }
  }

  async function copySmartApp(input: SmartAppDevelopmentInput) {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    if (!copyInstallation) return
    const current = requireCurrentInstallation(copyInstallation)
    setCreating(true)
    try {
      const installation = await harnessAppsApi.copyToDirectory(current.id, {
        parentPath: input.parentPath,
        name: input.name,
        displayName: input.displayName,
      })
      notifyHarnessAppInstallationsChanged({
        type: 'installed',
        installationId: installation.id,
        installation,
      })
      if (!isCurrent()) return
      setCopyInstallation(null)
      if (!isCurrent()) return
      await refresh()
      if (!isCurrent()) return
      await openBuilder(installation, 'develop')
    } finally {
      if (isCurrent()) setCreating(false)
    }
  }

  async function linkSmartAppDirectory() {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    if (!isCurrent()) return
    const selected = await invokeDesktopHost<{ canceled: boolean; filePaths: string[] }>(
      'dialog.open',
      {
        properties: ['openDirectory', 'createDirectory'],
      }
    )
    if (!isCurrent()) return
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
      if (!isCurrent()) return
      await refresh()
    } catch (value) {
      if (!isCurrent()) return
      setError(
        getSmartAppErrorMessage(
          value,
          t('workbench.smart_apps_link_failed', '关联工作台目录失败'),
          t
        )
      )
    } finally {
      if (isCurrent()) setImporting(false)
    }
  }

  async function importCreatedPackage(path: string) {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    setImporting(true)
    setError(null)
    try {
      await importSmartAppPackage(path)
      if (!isCurrent()) return
      await refresh()
    } catch (importError) {
      if (!isCurrent()) return
      setError(
        getSmartAppErrorMessage(
          importError,
          t('workbench.smart_apps_import_failed', '智能工作台导入失败'),
          t
        )
      )
    } finally {
      if (isCurrent()) setImporting(false)
    }
  }

  async function chooseCreatedPackage() {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    const selected = await invokeDesktopHost<{ canceled: boolean; filePaths: string[] }>(
      'dialog.open',
      {
        properties: ['openFile'],
        filters: [
          { name: t('workbench.smart_apps_package', '智能工作台发布包'), extensions: ['zip'] },
        ],
      }
    )
    if (!isCurrent()) return
    const path = selected.filePaths[0]
    if (!selected.canceled && path) await importCreatedPackage(path)
  }

  async function dropCreatedPackage(event: DragEvent<HTMLElement>) {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

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
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    setBusy(installation.id)
    setError(null)
    setExportNotice(null)
    try {
      await harnessAppsApi.exportToDownloads(installation.id)
      if (!isCurrent()) return
      setExportNotice(t('workbench.smart_apps_exported', '发布包已导出到下载目录。'))
    } catch (exportError) {
      if (!isCurrent()) return
      setError(
        getSmartAppErrorMessage(
          exportError,
          t('workbench.smart_apps_export_failed', '发布包导出失败。'),
          t
        )
      )
    } finally {
      if (isCurrent()) setBusy(null)
    }
  }

  async function verifyInstallation(installation: HarnessAppInstallation) {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    setBusy(installation.id)
    setError(null)
    setExportNotice(null)
    try {
      const report = await harnessAppsApi.verify(installation.id)
      if (!isCurrent()) return
      if (report.status !== 'passed') {
        const issue = report.issues[0]
        setError(
          [issue?.code, issue?.message, issue?.hint].filter(Boolean).join(' · ') ||
            t(
              'workbench.smart_apps_error_verification_failed',
              '工作台正式验证未通过，请查看验证结果并修复后再导出或发布。'
            )
        )
      } else {
        setExportNotice(t('workbench.smart_apps_verified', '工作台验证通过，可以导出或发布。'))
      }
    } catch (error) {
      if (!isCurrent()) return
      setError(
        getSmartAppErrorMessage(
          error,
          t(
            'workbench.smart_apps_error_verification_failed',
            '工作台正式验证未通过，请查看验证结果并修复后再导出或发布。'
          ),
          t
        )
      )
    } finally {
      if (isCurrent()) setBusy(null)
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
        disabled: !localReady || installation.state === 'running',
        onSelect: () => withCurrentInstallation(installation, focusModelSelector),
      })
      if (installation.source === 'market') {
        actions.push({
          label: t('workbench.smart_apps_copy_for_development', '复制为我的工作台'),
          icon: Copy,
          testId: `smart-app-copy-${installation.id}`,
          disabled: !localReady || installation.state === 'running',
          onSelect: () =>
            withCurrentInstallation(installation, current => {
              setCopyInstallation(current)
              setDevelopmentDialog('copy')
            }),
        })
      } else {
        actions.push(
          {
            label: t('workbench.smart_apps_add_plugins', '添加 DSH 插件'),
            icon: Wrench,
            testId: `smart-app-add-plugins-${installation.id}`,
            disabled: !localReady,
            onSelect: () => withCurrentInstallation(installation, setPluginInstallation),
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
              const isCurrent = pageView.captureOwner()
              void revealLocalFile(installation.packagePath).catch(openError => {
                if (!isCurrent()) return
                setError(
                  getSmartAppErrorMessage(
                    openError,
                    t('workbench.smart_apps_open_directory_failed', '打开工作台文件夹失败。'),
                    t
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
      if (installation.source === 'linked') {
        actions.push({
          label: t('workbench.smart_apps_verify', '验证工作台'),
          icon: Wrench,
          testId: `smart-app-verify-${installation.id}`,
          disabled: busy === installation.id,
          onSelect: () => verifyInstallation(installation),
        })
      }
      actions.push({
        label: t('workbench.smart_apps_export_package', '导出发布包'),
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
        disabled: !localReady,
        onSelect: () => withCurrentInstallation(installation, stopInstalledApp),
      })
    }
    actions.push(
      { separator: true, label: '', testId: `smart-app-local-separator-${installation.id}` },
      {
        label: t('workbench.smart_apps_remove_local', '从本机移除'),
        icon: Trash2,
        testId: `smart-app-remove-local-${installation.id}`,
        danger: true,
        disabled: !localReady,
        onSelect: () => withCurrentInstallation(installation, setPendingDelete),
      }
    )
    return actions
  }

  async function deleteLocalInstallation() {
    const isCurrent = pageView.captureOwner()
    if (!isCurrent()) return

    if (!pendingDelete) return
    const installation = currentInstallation(pendingDelete)
    if (!installation) return
    const installationId = installation.id
    setBusy(installationId)
    setError(null)
    try {
      if (installation.state === 'running' && !(await stopInstalledApp(installation, false))) {
        return
      }
      if (!isCurrent() || !currentInstallation(installation)) return
      setBusy(installationId)
      invalidateRefresh()
      notifyHarnessAppInstallationsChanged({ type: 'removed', installationId })
      setPendingDelete(null)
      await harnessAppsApi.delete(installationId)
      // Device-owned completion refreshes the catalog's current account owner.
      await refresh()
    } catch (deleteError) {
      notifyHarnessAppInstallationsChanged({
        type: 'restored',
        installationId,
        installation,
      })
      if (!isCurrent()) return
      setError(
        getSmartAppErrorMessage(
          deleteError,
          t('workbench.harness_apps_delete_failed', '卸载智能工作台失败。'),
          t
        )
      )
    } finally {
      if (isCurrent()) setBusy(null)
    }
  }

  return {
    currentInstallation,
    requireCurrentInstallation,
    withCurrentInstallation,
    download,
    install,
    openBuilder,
    addPluginToInstallation,
    createSmartApp,
    copySmartApp,
    linkSmartAppDirectory,
    importCreatedPackage,
    chooseCreatedPackage,
    dropCreatedPackage,
    availableUpdate,
    runtimeStateLabel,
    focusModelSelector,
    exportInstallation,
    verifyInstallation,
    localActions,
    deleteLocalInstallation,
  }
}
