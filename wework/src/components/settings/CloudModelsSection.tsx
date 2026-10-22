import { Network } from 'lucide-react'
import { useEffect, useState } from 'react'

import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'

import { createModelApi } from '@/api/models'
import { createUserApi } from '@/api/users'

import { useTranslation } from '@/hooks/useTranslation'

import type { UnifiedModel } from '@/types/api'

interface CloudRuntimeSettingsConnection {
  isConnected: boolean
  apiBaseUrl?: string
  token: string | null
}

function createRuntimeSettingsApis(connection: CloudRuntimeSettingsConnection) {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    throw new Error('Cloud connection is required')
  }
  const client = createHttpClient({
    baseUrl: connection.apiBaseUrl,
    getToken: () => connection.token,
    redirectOnUnauthorized: false,
  })
  return {
    deviceApi: createDeviceApi(client),
    modelApi: createModelApi(client),
    userApi: createUserApi(client),
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
function modelLabel(model: UnifiedModel) {
  return model.displayName || model.name
}
function modelMeta(model: UnifiedModel) {
  return [model.provider, model.runtime?.family, model.type].filter(Boolean).join(' · ')
}
export function CloudModelsSection({
  cloudConnection,
}: {
  cloudConnection: CloudRuntimeSettingsConnection
}) {
  const { t } = useTranslation('common')
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cloudConnection.isConnected) return undefined

    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (cancelled) return null
        setLoading(true)
        setError(null)
        return createRuntimeSettingsApis(cloudConnection).modelApi.listModels()
      })
      .then(response => {
        if (!cancelled && response) setModels(response.data)
      })
      .catch(loadError => {
        if (!cancelled) {
          setError(
            getErrorMessage(loadError, t('workbench.cloud_models_error', '云端模型加载失败'))
          )
          setModels([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [cloudConnection, t])

  const cloudSummaryRow = (
    <div className="flex min-h-11 items-start gap-3 rounded-lg border border-border bg-background px-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('workbench.cloud_models_title', '云端模型')}
          </h3>
          {!loading && (
            <span className="rounded-full bg-background px-2 py-0.5 text-xs text-text-secondary">
              {models.length}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          {t('workbench.cloud_models_desc', '服务端模型会出现在工作台模型选择器里。')}
        </p>
      </div>
    </div>
  )

  return (
    <div data-testid="cloud-models-section" className="grid gap-2">
      {cloudSummaryRow}
      {loading ? (
        <div className="rounded-lg border border-border bg-background px-3 py-3 text-sm text-text-secondary">
          {t('workbench.cloud_models_loading', '正在加载云端模型...')}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-sm text-red-500">
          {error}
        </div>
      ) : models.length === 0 ? (
        <div className="rounded-lg border border-border bg-background px-3 py-3 text-sm text-text-secondary">
          {t('workbench.cloud_models_empty', '暂无云端模型')}
        </div>
      ) : (
        <div className="grid gap-2">
          {models.slice(0, 8).map(model => (
            <div
              key={`${model.type}:${model.name}:${model.namespace ?? ''}`}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
            >
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
    </div>
  )
}

export function DisconnectedCloudModelsSection({
  onOpenCloudSettings,
}: {
  onOpenCloudSettings?: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-text-primary">
        {t('workbench.cloud_models_title')}
      </h2>
      <div
        data-testid="cloud-models-section"
        className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-4"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm text-text-primary">
              {t('connectCloud', { ns: 'modelConnections' })}
            </h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t('cloudHint', { ns: 'modelConnections' })}
          </p>
        </div>
        {onOpenCloudSettings && (
          <button
            type="button"
            data-testid="cloud-models-configure-button"
            onClick={onOpenCloudSettings}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            <Network className="h-3.5 w-3.5" />
            {t('connectCloud', { ns: 'modelConnections' })}
          </button>
        )}
      </div>
    </section>
  )
}
