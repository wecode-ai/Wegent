import { stripAppBasePath } from '@/config/runtime'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useWorkbenchCloudDeviceRestarts } from '@/features/cloud-devices/useWorkbenchCloudDeviceRestarts'
import { WorkbenchCloudDeviceRestarts } from '@/features/cloud-devices/WorkbenchCloudDeviceRestarts'
import {
  resolveDshSettingsPath,
  type WeworkDshSettingsPage,
} from '@/features/dsh-runtime/dshSettings'
import { resolveDshSettingsIcon } from '@/features/dsh-runtime/dshSettingsIcons'
import { DshSettingsSectionSurface } from '@/features/dsh-runtime/DshSettingsSectionSurface'
import { DshSettingsSurface } from '@/features/dsh-runtime/DshSettingsSurface'
import { DshSlotSurface } from '@/features/dsh-runtime/DshSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import type { RefreshWorkLists } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { isClaudeCodeDevice, isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import type { DeviceInfo as RuntimeDeviceInfo, RuntimeTaskAddress, UnifiedModel } from '@/types/api'
import type { DeviceInfo } from '@/types/devices'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Cloud, Code2, LogOut, Plus, Server } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { AddCloudDeviceDialog } from './AddCloudDeviceDialog'
import { ConnectorConnectionsSection } from './ConnectorConnectionsSection'
import { DeviceGitSyncSection } from './DeviceGitSyncSection'
import { DeviceSection } from './DeviceSection'
import { RemoteTaskAccessSetting } from './RemoteTaskAccessSetting'
import { type CloudSettingsConnection } from './settings-cloud-api'
import { SettingsPage, SettingsPageHeader } from './settings-ui'
import { createSettingsDeviceCollection } from './settingsDeviceCollection'
import { SettingsShell } from './SettingsShell'
import { useSettingsCloudModels } from './useSettingsCloudModels'

export { DeviceSection } from './DeviceSection'

interface ConnectionsSettingsPageProps {
  onBack: () => void
  autoOpenAddCloudDeviceDialog?: boolean
  services?: WorkbenchServices
  devices?: RuntimeDeviceInfo[]
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onRefreshWorkLists?: RefreshWorkLists
}

function getSettingsNavFromPath(
  path: string,
  contributions: readonly WeworkDshSettingsPage[]
): string {
  const normalizedPath = stripAppBasePath(path)
  return resolveDshSettingsPath(normalizedPath, contributions)?.id ?? 'general'
}

function cloudHostLabel(value?: string | null): string {
  if (!value) return '-'
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

function modelLabel(model: UnifiedModel): string {
  return model.displayName || model.name
}
function modelMeta(model: UnifiedModel): string {
  return [model.provider, model.runtime?.family, model.type].filter(Boolean).join(' · ')
}
function ConnectionCloudModelsSection({
  cloudConnection,
}: {
  cloudConnection: CloudSettingsConnection
}) {
  const { t } = useTranslation('common')
  const { snapshot } = useSettingsCloudModels(cloudConnection)
  const models = snapshot.data ?? []
  const loading = !snapshot.settled
  const error = snapshot.status === 'error'

  return (
    <section
      data-testid="cloud-models-section"
      className="rounded-lg border border-border bg-background p-5"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.cloud_models_title', '云端模型')}
          </h2>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t(
              'workbench.cloud_models_desc',
              '服务端模型会和本机 Codex 模型一起出现在工作台模型选择器里。'
            )}
          </p>
        </div>
        {!loading && (
          <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-text-secondary">
            {models.length}
          </span>
        )}
      </div>

      {loading ? (
        <div className="py-6 text-sm text-text-secondary">
          {t('workbench.cloud_models_loading', '正在加载云端模型...')}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive wework:border-red-500/20 wework:bg-red-500/10 wework:text-red-500">
          {t('workbench.cloud_models_error', '云端模型加载失败')}
        </div>
      ) : models.length === 0 ? (
        <div className="py-6 text-sm text-text-secondary">
          {t('workbench.cloud_models_empty', '暂无云端模型')}
        </div>
      ) : (
        <div className="grid gap-2">
          {models.slice(0, 8).map(model => (
            <div
              key={`${model.type}:${model.name}:${model.namespace ?? ''}`}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
            >
              <Code2 className="h-4 w-4 shrink-0 text-text-secondary" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary">
                  {modelLabel(model)}
                </div>
                <div className="truncate text-xs text-text-secondary">
                  {modelMeta(model) || model.name}
                </div>
              </div>
              {model.isActive === false && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted">
                  {t('workbench.plugin_detail_disabled', '已停用')}
                </span>
              )}
            </div>
          ))}
          {models.length > 8 && (
            <div className="px-1 pt-1 text-xs text-text-secondary">
              {t('workbench.cloud_models_more', {
                defaultValue: '还有 {{count}} 个模型',
                count: models.length - 8,
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function ConnectionsDeviceSettingsPage({
  autoOpenAddCloudDeviceDialog = false,
  showHeader = true,
}: {
  autoOpenAddCloudDeviceDialog?: boolean
  showHeader?: boolean
}) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const cloudRestarts = useWorkbenchCloudDeviceRestarts()
  const collection = useMemo(
    () => createSettingsDeviceCollection(cloudConnection),
    [cloudConnection]
  )
  const deviceSnapshot = useSyncExternalStore(
    collection.subscribe,
    collection.getSnapshot,
    collection.getServerSnapshot
  )
  const allDevices = deviceSnapshot.data ?? []
  const loading = !deviceSnapshot.settled
  const [connectDialogOpen, setConnectDialogOpen] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(autoOpenAddCloudDeviceDialog)
  const [creatingRequested, setCreating] = useState(false)
  const refreshDevices = collection.reload
  const handleDeviceCreated = useCallback(
    (discoveredDevices?: DeviceInfo[]) => {
      if (discoveredDevices) {
        collection.update(discoveredDevices)
        return
      }
      return collection.reload()
    },
    [collection]
  )
  const devices = allDevices.filter(isClaudeCodeDevice)
  const cloudDevices = devices.filter(isCloudDevice)
  const remoteDevices = devices.filter(isRemoteDevice)
  const connectionDevices = [...cloudDevices, ...remoteDevices]
  if (creatingRequested && cloudDevices.length > 0) setCreating(false)
  const creating = creatingRequested && cloudDevices.length === 0
  const cloudDeviceCount = allDevices.filter(
    device => isCloudDevice(device) || isRemoteDevice(device)
  ).length
  useWindowEvent(
    'focus',
    () => {
      void refreshDevices()
    },
    { enabled: cloudConnection.isConnected }
  )

  if (!cloudConnection.isConnected) {
    return (
      <>
        <SettingsPage data-testid="connections-device-settings-page">
          {showHeader ? (
            <SettingsPageHeader title={t('workbench.connections_title', '云端连接')} />
          ) : null}

          <section className="rounded-lg border border-border bg-background p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('workbench.cloud_connection_local_mode', '本地模式')}
                </h2>
                <p className="mt-1 text-sm leading-6 text-text-secondary">
                  {t(
                    'workbench.cloud_connection_local_mode_desc',
                    '默认功能不依赖服务端：本机 Codex、本地任务服务、本地工作区和会话都会继续可用。'
                  )}
                </p>
              </div>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {t('workbench.cloud_connection_available', '可用')}
              </span>
            </div>
          </section>

          <section className="mt-4 rounded-lg border border-dashed border-border bg-background p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('workbench.cloud_connection_cloud_features', '连接云端后')}
                </h2>
                <p className="mt-1 text-sm leading-6 text-text-secondary">
                  {t(
                    'workbench.cloud_connection_cloud_features_desc',
                    '服务端模型、云设备、云端 Codex auth.json 同步、代理和远程设备管理会加入现有工作台。'
                  )}
                </p>
              </div>
              <ControlButton
                variant="primary"
                size="sm"
                type="button"
                data-testid="settings-cloud-connect-button"
                onClick={() => setConnectDialogOpen(true)}
                className="shrink-0"
              >
                {t('workbench.cloud_connection_connect_action', '连接云端')}
              </ControlButton>
            </div>
          </section>

          {isElectronRuntime() ? <RemoteTaskAccessSetting /> : null}
          <DshSettingsSectionSurface page="connections" />
        </SettingsPage>

        {connectDialogOpen && (
          <CloudConnectionDialog
            open
            onlineCloudDeviceCount={0}
            onClose={() => setConnectDialogOpen(false)}
            onOpenSettings={() => undefined}
          />
        )}
      </>
    )
  }

  const content = (
    <>
      <SettingsPage data-testid="connections-device-settings-page">
        {showHeader ? (
          <SettingsPageHeader title={t('workbench.connections_title', '云端连接')} />
        ) : null}

        <section
          data-testid="cloud-connection-status-card"
          className="rounded-lg border border-border bg-background p-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2 w-2 rounded-full bg-primary" />
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('workbench.cloud_connection_status_connected', '已连接云端')}
                </h2>
              </div>
              <div className="mt-3 grid gap-2 text-sm text-text-secondary">
                <div>
                  {t('workbench.cloud_connection_host', '当前域名')}:{' '}
                  <span className="font-medium text-text-primary">
                    {cloudHostLabel(cloudConnection.backendUrl)}
                  </span>
                </div>
                <div>
                  {t('workbench.cloud_connection_user', '云端用户')}:{' '}
                  <span className="font-medium text-text-primary">
                    {cloudConnection.user?.user_name ?? '-'}
                  </span>
                </div>
                <div>
                  {t('workbench.cloud_connection_devices')}:{' '}
                  <span
                    data-testid="cloud-connection-device-count"
                    className="font-medium text-text-primary"
                  >
                    {cloudDeviceCount}
                  </span>
                </div>
              </div>
            </div>
            <ControlButton
              variant="outline"
              size="sm"
              type="button"
              data-testid="settings-cloud-disconnect-button"
              onClick={() => {
                cloudConnection.disconnect()
              }}
              className="shrink-0"
            >
              <LogOut className="h-4 w-4" />
              {t('workbench.cloud_connection_disconnect', '断开连接')}
            </ControlButton>
          </div>
        </section>

        {isElectronRuntime() ? <RemoteTaskAccessSetting /> : null}
        <section className="mt-6 space-y-5">
          <DshSettingsSectionSurface page="connections" />

          <ConnectionCloudModelsSection cloudConnection={cloudConnection} />

          <ConnectorConnectionsSection
            apiBaseUrl={cloudConnection.apiBaseUrl ?? null}
            token={cloudConnection.token}
          />

          <div className="rounded-lg border border-border bg-background p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">
                {t('workbench.connections_authorized_devices', '云端设备')}
              </h2>
              {!loading && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="connection-add-device-button"
                  onClick={() => setAddDialogOpen(true)}
                  disabled={creating}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-surface px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  {t('workbench.connection_add', '添加')}
                </ControlButton>
              )}
            </div>

            <div className="space-y-5">
              {creating && (
                <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2.5 text-xs text-text-secondary">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-text-secondary" />
                  云设备创建中，初始化约需 2-3 分钟，完成后将自动出现在列表中
                </div>
              )}
              {deviceSnapshot.status === 'error' && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 rounded-lg border border-destructive/20 px-3 py-2 text-sm text-destructive"
                >
                  <span>
                    {deviceSnapshot.error instanceof Error
                      ? deviceSnapshot.error.message
                      : t('workbench.load_failed')}
                  </span>
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="connection-devices-retry"
                    onClick={() => void refreshDevices()}
                    className="shrink-0 rounded-md px-2 py-1 hover:bg-muted"
                  >
                    {t('workbench.retry')}
                  </ControlButton>
                </div>
              )}
              {loading ? (
                <div className="py-8 text-center text-sm text-text-secondary">
                  {t('common.loading', '加载中...')}
                </div>
              ) : deviceSnapshot.data === undefined ? null : connectionDevices.length === 0 ? (
                <div className="py-8 text-center text-sm text-text-secondary">
                  {t('workbench.connection_empty_devices')}
                </div>
              ) : (
                <>
                  {cloudDevices.length > 0 && (
                    <DeviceSection
                      title={t('workbench.connection_cloud_devices', '云设备')}
                      devices={cloudDevices}
                      icon={Cloud}
                      onChanged={refreshDevices}
                    />
                  )}
                  {remoteDevices.length > 0 && (
                    <DeviceSection
                      title={t('workbench.connection_remote_devices', '远程设备')}
                      devices={remoteDevices}
                      icon={Server}
                      onChanged={refreshDevices}
                    />
                  )}
                </>
              )}
            </div>
          </div>

          <DeviceGitSyncSection
            devices={devices}
            devicesLoading={loading}
            onRefreshDevices={refreshDevices}
          />
        </section>
      </SettingsPage>

      <AddCloudDeviceDialog
        open={addDialogOpen}
        hasCloudDevice={cloudDevices.length > 0 || creating}
        cloudConnection={cloudConnection}
        onClose={() => setAddDialogOpen(false)}
        onCreated={handleDeviceCreated}
        onCreatingChange={setCreating}
      />
    </>
  )

  return cloudRestarts ? (
    content
  ) : (
    <WorkbenchCloudDeviceRestarts devices={allDevices} refreshDevices={refreshDevices}>
      {content}
    </WorkbenchCloudDeviceRestarts>
  )
}

export function ConnectionsSettingsPage({
  onBack,
  autoOpenAddCloudDeviceDialog = false,
  services,
  devices = [],
  onOpenRuntimeTask,
  onRefreshWorkLists,
}: ConnectionsSettingsPageProps) {
  const { t } = useTranslation('common')
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const isDesktopRuntime = isElectronRuntime()
  const settingsContributions = useDshSlotEntries<WeworkDshSettingsPage>(
    WEWORK_DSH_SLOTS.settingsPage
  )
  const visibleSettingsNavItems = useMemo(() => {
    const visible = settingsContributions.filter(
      item =>
        (!item.experimental || experimentalFeaturesEnabled) &&
        (!item.desktopOnly || isDesktopRuntime)
    )
    const categoryOrder: string[] = []
    const categoryItems = new Map<string, WeworkDshSettingsPage[]>()
    for (const item of visible) {
      const category = item.category ?? ''
      if (!categoryItems.has(category)) {
        categoryOrder.push(category)
        categoryItems.set(category, [])
      }
      categoryItems.get(category)?.push(item)
    }
    return categoryOrder.flatMap(category => categoryItems.get(category) ?? [])
  }, [experimentalFeaturesEnabled, isDesktopRuntime, settingsContributions])
  const shouldAutoOpenAddCloudDeviceDialog =
    autoOpenAddCloudDeviceDialog ||
    new URLSearchParams(window.location.search).get('addDevice') === '1'
  const [activeNav, setActiveNav] = useState(() =>
    getSettingsNavFromPath(window.location.pathname, settingsContributions)
  )
  const effectiveActiveNav = visibleSettingsNavItems.some(item => item.id === activeNav)
    ? activeNav
    : (visibleSettingsNavItems.find(item => item.id === 'general')?.id ??
      visibleSettingsNavItems[0]?.id ??
      'general')

  useWindowEvent('popstate', () => {
    setActiveNav(getSettingsNavFromPath(window.location.pathname, settingsContributions))
  })

  const openCloudSettings = useCallback(() => {
    setActiveNav('connections')
    const path = settingsContributions.find(item => item.id === 'connections')?.path
    navigateTo(path ?? '/settings/connections')
  }, [settingsContributions])
  const activeContribution =
    settingsContributions.find(item => item.id === effectiveActiveNav) ??
    settingsContributions.find(item => item.id === 'general')

  return (
    <SettingsShell
      onBack={onBack}
      activeLabel={
        activeContribution
          ? t(
              `workbench.${activeContribution.labelKey ?? activeContribution.id}`,
              activeContribution.label
            )
          : t('workbench.settings', '设置')
      }
      navigation={closeNavigation => (
        <nav
          data-testid="settings-sidebar-nav"
          className="scrollbar-soft min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5"
        >
          {visibleSettingsNavItems.map((item, index) => {
            const showCategory =
              item.category && visibleSettingsNavItems[index - 1]?.category !== item.category
            return (
              <div key={item.id}>
                {showCategory && (
                  <div
                    data-testid={`settings-category-${item.category}`}
                    className={cn(
                      'mb-1 px-2.5 text-xs font-medium text-text-secondary',
                      index === 0 ? 'mt-2' : 'mt-5'
                    )}
                  >
                    {t(`workbench.${item.categoryLabelKey}`, item.categoryLabel)}
                  </div>
                )}
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`settings-nav-${item.id}`}
                  aria-current={effectiveActiveNav === item.id ? 'page' : undefined}
                  onClick={() => {
                    closeNavigation()
                    setActiveNav(item.id)
                    navigateTo(item.path)
                  }}
                  className={[
                    'flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium md:min-h-[31px]',
                    effectiveActiveNav === item.id
                      ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
                      : 'text-text-primary hover:bg-[rgb(var(--color-sidebar-hover))]',
                  ].join(' ')}
                >
                  {(() => {
                    const Icon = resolveDshSettingsIcon(item.icon)
                    return <Icon className="h-4 w-4 shrink-0" />
                  })()}
                  <span className="truncate">
                    {t(`workbench.${item.labelKey ?? item.id}`, item.label)}
                  </span>
                  {item.experimental ? (
                    <ExperimentalBadge
                      className="ml-auto"
                      testId={`settings-nav-${item.id}-experimental-badge`}
                    />
                  ) : null}
                </ControlButton>
              </div>
            )
          })}
        </nav>
      )}
    >
      {activeContribution?.module ? (
        <DshSettingsSurface
          page={activeContribution}
          services={services}
          devices={devices}
          onBack={onBack}
          onOpenCloudSettings={openCloudSettings}
          onOpenRuntimeTask={onOpenRuntimeTask}
          onRefreshWorkLists={onRefreshWorkLists}
          autoOpenAddCloudDeviceDialog={shouldAutoOpenAddCloudDeviceDialog}
        />
      ) : activeContribution ? (
        <DshSlotSurface
          className="contents"
          entryId={activeContribution.id}
          props={{
            services,
            devices,
            onBack,
            onOpenCloudSettings: openCloudSettings,
            onOpenRuntimeTask,
            onRefreshWorkLists,
            autoOpenAddCloudDeviceDialog: shouldAutoOpenAddCloudDeviceDialog,
          }}
          slot={WEWORK_DSH_SLOTS.settingsPage}
          testId={`dsh-settings-surface-${activeContribution.id}`}
        />
      ) : null}
    </SettingsShell>
  )
}
