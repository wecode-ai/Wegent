import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { ApiError } from '@/api/http'
import type { SmartAppsApi } from '@/api/smartApps'
import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { track } from '@/telemetry/client'
import { notifyHarnessAppInstallationsChanged } from './harnessAppInstallationsChanged'
import { parseSmartAppOpenRoute } from './smartAppDeepLink'

export function smartAppErrorMessage(
  error: unknown,
  fallback: string,
  storageUnavailable: string
): string {
  if (error instanceof ApiError && error.errorCode === 'smart_app_storage_unavailable') {
    return storageUnavailable
  }
  return getErrorMessage(error, fallback)
}

interface UseSmartAppDeepLinkOpenOptions {
  api: SmartAppsApi | null
  hasCompletedModelLoad: boolean
  isMarketplaceLoading: boolean
  mode: 'marketplace' | 'owned'
  modelOptions: LocalHarnessModelOption[]
  openInstalledApp: (installation: HarnessAppInstallation) => void
  setBusy: (value: string | null) => void
  setError: (value: string | null) => void
  setInstalled: Dispatch<SetStateAction<HarnessAppInstallation[]>>
  startInstalledApp: (installation: HarnessAppInstallation) => void
  stopInstalledApp: (installation: HarnessAppInstallation, refresh?: boolean) => Promise<boolean>
}

export function useSmartAppDeepLinkOpen({
  api,
  hasCompletedModelLoad,
  isMarketplaceLoading,
  mode,
  modelOptions,
  openInstalledApp,
  setBusy,
  setError,
  setInstalled,
  startInstalledApp,
  stopInstalledApp,
}: UseSmartAppDeepLinkOpenOptions): void {
  const { t } = useTranslation('common')
  const handledRequestRef = useRef<number | null>(null)

  const openSharedSmartApp = useCallback(
    async (smartAppId: number) => {
      if (!api) return
      setBusy(`deep-link-${smartAppId}`)
      setError(null)
      try {
        const item = await api.getItem(smartAppId)
        const localInstallations = await harnessAppsApi.list()
        const current = localInstallations.find(
          installation => installation.smartAppId === smartAppId
        )
        const selectedModelKey =
          current?.modelKey && modelOptions.some(option => option.key === current.modelKey)
            ? current.modelKey
            : modelOptions[0]?.key
        if (!selectedModelKey) {
          throw new Error(
            t(
              'workbench.harness_apps_no_models',
              '当前没有可用的 Wework 模型，请先在模型设置中完成配置。'
            )
          )
        }

        if (current?.releaseId === item.latestReleaseId) {
          if (current.state === 'running' && current.modelKey !== selectedModelKey) {
            const stopped = await stopInstalledApp(current, false)
            if (!stopped) return
          }
          const ready =
            current.modelKey === selectedModelKey
              ? current
              : await harnessAppsApi.update(current.id, { modelKey: selectedModelKey })
          setInstalled(localInstallations.map(value => (value.id === ready.id ? ready : value)))
          if (ready.state === 'running' && ready.webUrl) openInstalledApp(ready)
          else startInstalledApp(ready)
          return
        }

        if (current?.state === 'running') {
          const stopped = await stopInstalledApp(current, false)
          if (!stopped) return
        }
        const descriptor = await api.getDownload(smartAppId)
        const preview = await harnessAppsApi.download(descriptor)
        const installation = await harnessAppsApi.install(preview, selectedModelKey, {
          smartAppId,
          releaseId: item.latestReleaseId,
        })
        notifyHarnessAppInstallationsChanged({
          type: 'installed',
          installationId: installation.id,
          installation,
        })
        if (current) {
          track('feature_action_completed', { domain: 'smart_app', action: 'update' })
        } else {
          track('smart_app_installed', {
            domain: 'smart_app',
            install_source: 'marketplace',
          })
        }
        setInstalled(currentInstallations => [
          ...currentInstallations.filter(value => value.id !== installation.id),
          installation,
        ])
        startInstalledApp(installation)
      } catch (openError) {
        setError(
          smartAppErrorMessage(
            openError,
            t('workbench.smart_apps_link_open_failed', '无法从分享链接打开智能工作台'),
            t('workbench.smart_apps_storage_unavailable', '文件存储服务暂不可用，请稍后重试')
          )
        )
      } finally {
        setBusy(null)
      }
    },
    [
      api,
      modelOptions,
      openInstalledApp,
      setBusy,
      setError,
      setInstalled,
      startInstalledApp,
      stopInstalledApp,
      t,
    ]
  )

  useEffect(() => {
    if (mode !== 'marketplace' || !api || !hasCompletedModelLoad || isMarketplaceLoading) return
    const request = parseSmartAppOpenRoute(window.location.search)
    if (!request || handledRequestRef.current === request.smartAppId) return
    handledRequestRef.current = request.smartAppId
    queueMicrotask(async () => {
      await openSharedSmartApp(request.smartAppId)
      window.history.replaceState(window.history.state, '', '/sites?app_type=smart_app')
      handledRequestRef.current = null
    })
  }, [api, hasCompletedModelLoad, isMarketplaceLoading, mode, openSharedSmartApp])
}
