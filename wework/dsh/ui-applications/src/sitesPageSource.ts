import { ApiError } from '@/api/http'
import type { createPluginApi } from '@/api/plugins'
import type { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import type { Site, SiteAppType, SitesApi } from '@/api/sites'
import type { InstalledPlugin, RuntimeTaskAddress, User } from '@/types/api'
import {
  getApplicationTypeDefinition,
  type ApplicationCreateStrategy,
} from '@/components/sites/applicationTypeDefinitions'
import {
  ApplicationPluginSyncConfirmationError,
  PluginInstallationInspectionError,
  applicationPluginReferenceName,
  preparePluginTrial,
} from '@/features/plugins/preparePluginTrial'
import { notifyLocalPluginSkillsChanged, queuePluginTrial } from '@/features/plugins/pluginTrial'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import type { useTranslation } from '@/hooks/useTranslation'
interface PreparedApplicationPlugin {
  plugin: InstalledPlugin
  pluginName: string
  marketplaceName: string
}

function sanitizeMarkdownLinkLabel(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\[/g, ' ')
    .replace(/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildSiteContinueDevelopmentInput(
  site: Pick<Site, 'name' | 'project_id' | 'siteid'>,
  suffix: string
): string | null {
  const projectId = String(site.project_id || site.siteid || '').trim()
  if (!projectId) return null
  const label = sanitizeMarkdownLinkLabel(site.name) || projectId
  const normalizedSuffix = suffix.trim()
  return `[${label}](wegent-sites-project://${encodeURIComponent(projectId)})${
    normalizedSuffix ? ` ${normalizedSuffix}` : ''
  }`
}

type Translate = ReturnType<typeof useTranslation>['t']
export interface SitesPageOwner {
  sitesApi: SitesApi
  pluginApi: ReturnType<typeof createPluginApi> | null
  localPluginApi: ReturnType<typeof createLocalCodexPluginApi>
  userId: User['id'] | undefined
  targetDeviceId: string | null | undefined
  runtimeInstance: string | null | undefined
  backendUrl: string | null | undefined
  token: string | null | undefined
}
interface SitesPageInput {
  t: Translate
  isDesktop: boolean
  search: string
  experimentalFeatures: { loaded: boolean; enabled: boolean }
  openRuntimeTask(address: RuntimeTaskAddress): Promise<void>
}
interface SitesPageSnapshot {
  createError: string | null
  createNotice: string | null
  creatingType: SiteAppType | null
  continuingSiteId: string | null
}
function initialSnapshot(): SitesPageSnapshot {
  return { createError: null, createNotice: null, creatingType: null, continuingSiteId: null }
}
/** Application creation, confirmed plugin installation and Sites navigation share one scoped owner. */
export function createSitesPageSource() {
  let snapshot = initialSnapshot()
  let owner: SitesPageOwner | undefined
  let input: SitesPageInput | undefined
  let generation = 0,
    createRequest = 0,
    continueRequest = 0
  let navigationGate: string | undefined
  let noticeOwner: object | undefined
  const listeners = new Set<() => void>()
  const publish = (change: Partial<SitesPageSnapshot>) => {
    snapshot = { ...snapshot, ...change }
    listeners.forEach(listener => listener())
  }
  const setCreateError = (createError: string | null) => publish({ createError })
  const lease = () => {
    if (!owner || !input || !listeners.size) return null
    const currentOwner = owner,
      currentInput = input,
      version = generation
    return {
      owner: currentOwner,
      input: currentInput,
      isCurrent: () => owner === currentOwner && generation === version && listeners.size > 0,
    }
  }
  const handleApplicationPluginError = (error: unknown, t: Translate) => {
    console.error('[Wework Applications] plugin preparation failed', error)
    if (error instanceof PluginInstallationInspectionError) {
      setCreateError(t('plugin_inspection_failed', '无法确认目标设备的插件安装状态，请重试'))
    } else if (error instanceof ApiError && error.status === 404) {
      setCreateError(
        t(
          'plugin_backend_upgrade_required',
          '云端 Backend 尚未支持对应的应用插件，请先部署最新 Backend'
        )
      )
    } else if (error instanceof ApiError && error.status === 503) {
      setCreateError(
        t('plugin_not_published', '云端市场尚未发布对应的应用插件，请检查内置插件打包配置')
      )
    } else if (error instanceof ApiError && error.status === 409) {
      setCreateError(t('plugin_device_unavailable', '目标设备当前离线，请连接设备后重试'))
    } else if (error instanceof ApiError && error.status === 502) {
      setCreateError(t('plugin_device_sync_failed', '应用插件未能同步到目标设备，请检查设备后重试'))
    } else if (error instanceof ApplicationPluginSyncConfirmationError) {
      setCreateError(t('plugin_device_sync_failed', '应用插件未能同步到目标设备，请检查设备后重试'))
    } else {
      setCreateError(t('plugin_install_failed', '应用插件安装失败，请重试'))
    }
  }

  async function prepareApplicationPlugin(
    createStrategy: ApplicationCreateStrategy,
    scope: NonNullable<ReturnType<typeof lease>>
  ): Promise<PreparedApplicationPlugin | null> {
    const {
      owner: currentOwner,
      input: { t, isDesktop },
    } = scope
    const { pluginApi, localPluginApi, targetDeviceId } = currentOwner
    if (!createStrategy.pluginName || !createStrategy.marketplaceName) {
      setCreateError(
        t('plugin_create_configuration_missing', '应用创建插件配置尚未同步，请刷新后重试')
      )
      return null
    }
    if (!pluginApi) {
      setCreateError(t('plugin_cloud_unavailable', '连接云端后才能使用应用创建插件'))
      return null
    }
    if (!targetDeviceId) {
      setCreateError(t('plugin_device_unavailable', '请选择一个在线且版本兼容的设备后再创建应用'))
      return null
    }
    const assertCurrent = () => {
      if (!scope.isCurrent()) throw new Error('The application creation owner is no longer active')
    }
    let installed = false
    const plugin = await preparePluginTrial({
      pluginName: createStrategy.pluginName,
      marketplaceName: createStrategy.marketplaceName,
      deviceId: targetDeviceId,
      readLocalInstalledPlugins: isDesktop
        ? () => {
            assertCurrent()
            return localPluginApi.listInstalledPlugins({ refresh: true, requireComplete: true })
          }
        : undefined,
      listInstalledPlugins: deviceId => {
        assertCurrent()
        return pluginApi.listInstalledPlugins(deviceId)
      },
      ensureInstalled: async (pluginName, deviceId) => {
        assertCurrent()
        const receipt = await pluginApi.ensureBuiltinPluginInstalled(pluginName, { deviceId })
        installed = true
        return receipt
      },
      onInstalling: () => {
        if (scope.isCurrent()) {
          noticeOwner = scope
          publish({ createNotice: t('plugin_installing', '正在安装应用插件，完成后将进入会话...') })
        }
      },
    })
    if (!scope.isCurrent()) {
      // Confirm accepted installations even after their originating view has left.
      if (installed) notifyLocalPluginSkillsChanged()
      return null
    }
    return {
      plugin,
      pluginName: createStrategy.pluginName,
      marketplaceName: createStrategy.marketplaceName,
    }
  }
  function normalizeNavigation(next: SitesPageInput) {
    const requested = new URLSearchParams(next.search).get('app_type') === 'smart_app'
    const { loaded, enabled } = next.experimentalFeatures
    const gate = JSON.stringify([requested, loaded, enabled])
    if (navigationGate === gate) return
    navigationGate = gate
    if (requested && loaded && !enabled) navigateTo('/sites')
  }
  return {
    observe(nextOwner: SitesPageOwner) {
      const inactive = initialSnapshot()
      const isCurrent = () => owner === nextOwner && listeners.size > 0
      return {
        getSnapshot: () => (owner === nextOwner ? snapshot : inactive),
        async openTask(address: RuntimeTaskAddress) {
          if (!isCurrent()) return
          const scope = lease()
          if (!scope) return
          await scope.input.openRuntimeTask(address)
          if (scope.isCurrent()) navigateTo(buildRuntimeTaskRoute(address))
        },
        async create(appType: SiteAppType, createStrategy: ApplicationCreateStrategy) {
          if (!isCurrent() || snapshot.creatingType) return
          const scope = lease()
          if (!scope) return
          const request = ++createRequest
          const current = () => scope.isCurrent() && request === createRequest
          const operation = { ...scope, isCurrent: current }
          const { t } = scope.input
          publish({ creatingType: appType, createError: null })
          try {
            if (!getApplicationTypeDefinition(appType)) {
              setCreateError(t('unsupported_application_type', '当前版本不支持该应用类型'))
              return
            }
            const prepared = await prepareApplicationPlugin(createStrategy, operation)
            if (!prepared || !current()) return
            const queued = queuePluginTrial(prepared.plugin, {
              openInNewChat: true,
              reference: {
                pluginName: prepared.pluginName,
                marketplaceName: prepared.marketplaceName,
                displayName: applicationPluginReferenceName(prepared.plugin, prepared.pluginName),
              },
            })
            if (!queued)
              throw new Error('The installed application plugin cannot be referenced in chat')
            notifyLocalPluginSkillsChanged()
            publish({ createError: null, createNotice: null })
            navigateTo('/')
          } catch (error) {
            if (current()) handleApplicationPluginError(error, t)
          } finally {
            if (owner === scope.owner && request === createRequest) {
              publish({
                creatingType: null,
                ...(noticeOwner === operation ? { createNotice: null } : {}),
              })
              if (noticeOwner === operation) noticeOwner = undefined
            }
          }
        },
        async continueDevelopment(site: Site, createStrategy: ApplicationCreateStrategy) {
          if (!isCurrent() || snapshot.continuingSiteId) return
          const scope = lease()
          if (!scope) return
          const request = ++continueRequest
          const current = () => scope.isCurrent() && request === continueRequest
          const operation = { ...scope, isCurrent: current }
          const { t } = scope.input
          publish({ continuingSiteId: site.siteid, createError: null })
          try {
            const prepared = await prepareApplicationPlugin(createStrategy, operation)
            if (!prepared || !current()) return
            const prompt = buildSiteContinueDevelopmentInput(
              site,
              t('continue_development_prompt_suffix', '请说出你要做的改动')
            )
            if (!prompt) {
              setCreateError(
                t('plugin_create_configuration_missing', '应用创建插件配置尚未同步，请刷新后重试')
              )
              return
            }
            const queued = queuePluginTrial(prepared.plugin, {
              openInNewChat: true,
              reference: {
                pluginName: prepared.pluginName,
                marketplaceName: prepared.marketplaceName,
                displayName: applicationPluginReferenceName(prepared.plugin, prepared.pluginName),
              },
              prompt,
            })
            if (!queued)
              throw new Error('The installed application plugin cannot be referenced in chat')
            notifyLocalPluginSkillsChanged()
            publish({ createError: null, createNotice: null })
            navigateTo('/')
          } catch (error) {
            if (current()) handleApplicationPluginError(error, t)
          } finally {
            if (owner === scope.owner && request === continueRequest) {
              publish({
                continuingSiteId: null,
                ...(noticeOwner === operation ? { createNotice: null } : {}),
              })
              if (noticeOwner === operation) noticeOwner = undefined
            }
          }
        },
        subscribe(listener: () => void, next: SitesPageInput) {
          listeners.add(listener)
          if (owner !== nextOwner) {
            owner = nextOwner
            snapshot = inactive
            generation++
            createRequest++
            continueRequest++
            noticeOwner = undefined
          }
          input = next
          normalizeNavigation(next)
          return () => {
            listeners.delete(listener)
            queueMicrotask(() => {
              if (listeners.size) return
              generation++
              navigationGate = undefined
            })
          }
        },
      }
    },
  }
}
