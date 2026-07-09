import { AlertCircle, CheckCircle2, Link2, Loader2, Package, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { isClaudeCodeDevice } from '@/lib/device-capabilities'
import type { SkillDirectorySetupResult } from '@/types/api'
import type { DeviceInfo } from '@/types/devices'
import { createActiveSettingsDeviceApi } from './settings-cloud-api'

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export function SkillSettingsPage() {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SkillDirectorySetupResult | null>(null)

  const onlineDevices = useMemo(
    () => devices.filter(device => device.status === 'online' && isClaudeCodeDevice(device)),
    [devices]
  )
  const selectedDevice = useMemo(
    () =>
      onlineDevices.find(device => device.device_id === selectedDeviceId) ??
      onlineDevices[0] ??
      null,
    [onlineDevices, selectedDeviceId]
  )
  const effectiveDeviceId = selectedDevice?.device_id ?? ''

  const loadDevices = useCallback(
    async (refresh = false) => {
      if (refresh) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      setError(null)
      try {
        const allDevices = await createActiveSettingsDeviceApi(cloudConnection).getAllDevices()
        setDevices(allDevices.filter(isClaudeCodeDevice))
      } catch (loadError) {
        setError(
          getErrorMessage(loadError, t('workbench.skill_management_load_failed', '加载设备失败'))
        )
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [cloudConnection, t]
  )

  useEffect(() => {
    void Promise.resolve().then(() => loadDevices())
  }, [loadDevices])

  const handleSetupSharedSkills = async () => {
    if (!effectiveDeviceId || configuring) return

    setConfiguring(true)
    setError(null)
    setResult(null)
    try {
      const nextResult =
        await createActiveSettingsDeviceApi(cloudConnection).setupSharedSkills(effectiveDeviceId)
      setResult(nextResult)
    } catch (setupError) {
      setError(
        getErrorMessage(
          setupError,
          t('workbench.skill_management_setup_failed', '统一管理技能失败')
        )
      )
    } finally {
      setConfiguring(false)
    }
  }

  const renamedCount = result?.moved.filter(item => item.renamed).length ?? 0

  return (
    <div data-testid="skill-settings-page" className="mx-auto w-full max-w-[820px]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.skill_management_title', '技能')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {t('workbench.skill_management_subtitle', '统一管理本地 Claude 和 Codex 技能目录')}
          </p>
        </div>
        <button
          type="button"
          data-testid="skill-management-refresh-button"
          onClick={() => void loadDevices(true)}
          disabled={loading || refreshing}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-surface text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('workbench.skill_management_refresh', '刷新')}
          title={t('workbench.skill_management_refresh', '刷新')}
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="mt-8">
        {loading ? (
          <div className="py-8 text-center text-sm text-text-secondary">
            {t('common.loading', '加载中...')}
          </div>
        ) : (
          <section className="rounded-lg border border-border bg-background p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Package className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-text-primary">
                    {t('workbench.skill_management_shared_title', '统一管理本地技能')}
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {t(
                      'workbench.skill_management_shared_description',
                      '启用后会创建 ~/.agents/skills，将 ~/.codex/skills 和 ~/.claude/skills 的现有技能迁移到该目录，并把两个旧目录改为指向共享目录的软链接。'
                    )}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
              <div className="rounded-lg border border-border bg-surface p-3">
                <h3 className="text-sm font-semibold text-text-primary">
                  {t('workbench.skill_management_device_title', '目标设备')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.skill_management_device_description',
                    '选择一台在线 Claude Code 设备执行本地目录迁移。'
                  )}
                </p>
                <select
                  data-testid="skill-management-device-select"
                  value={effectiveDeviceId}
                  onChange={event => setSelectedDeviceId(event.target.value)}
                  disabled={onlineDevices.length === 0 || configuring}
                  className="mt-3 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={t('workbench.skill_management_select_device', '选择设备')}
                >
                  {onlineDevices.length === 0 ? (
                    <option value="">
                      {t(
                        'workbench.skill_management_no_online_devices',
                        '没有在线 Claude Code 设备'
                      )}
                    </option>
                  ) : (
                    onlineDevices.map(device => (
                      <option key={device.device_id} value={device.device_id}>
                        {device.name}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="rounded-lg border border-border bg-surface p-3">
                <h3 className="text-sm font-semibold text-text-primary">
                  {t('workbench.skill_management_action_title', '统一目录')}
                </h3>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.skill_management_action_description',
                    '该操作可重复执行；已配置的软链接会保持不变。'
                  )}
                </p>
                <button
                  type="button"
                  data-testid="skill-management-enable-button"
                  onClick={() => void handleSetupSharedSkills()}
                  disabled={!effectiveDeviceId || configuring}
                  className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {configuring ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5" />
                  )}
                  {configuring
                    ? t('workbench.skill_management_configuring', '配置中')
                    : t('workbench.skill_management_enable', '启用统一管理')}
                </button>
              </div>
            </div>

            {result && (
              <div
                data-testid="skill-management-result"
                className="mt-5 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary"
              >
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium">
                      {t('workbench.skill_management_setup_success', '已启用统一管理')}
                    </div>
                    <div className="mt-1 break-all text-xs leading-5">{result.shared_path}</div>
                    <div className="mt-1 text-xs leading-5">
                      {t('workbench.skill_management_moved_count', {
                        defaultValue: '已迁移 {{count}} 个条目',
                        count: result.moved_count,
                      })}
                      {renamedCount > 0 &&
                        t('workbench.skill_management_renamed_count', {
                          defaultValue: '，其中 {{count}} 个因重名已自动改名',
                          count: renamedCount,
                        })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div
                data-testid="skill-management-error"
                className="mt-5 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
