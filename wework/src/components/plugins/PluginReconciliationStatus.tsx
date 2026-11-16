import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginReconciliationStage } from '@/features/plugins/pluginRefreshReconciliation'

export function PluginReconciliationStatus({
  stage,
  startedAt,
}: {
  stage: PluginReconciliationStage
  startedAt: number | null
}) {
  const { t } = useTranslation('common')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const labels: Record<PluginReconciliationStage, string> = {
    waiting: t('workbench.plugins_reconciliation_waiting', '等待其他插件操作完成…'),
    reading: t('workbench.plugins_reconciliation_reading', '1/3 读取本机插件…'),
    syncing: t('workbench.plugins_reconciliation_syncing', '2/3 核对并修复本机插件…'),
    verifying: t('workbench.plugins_reconciliation_verifying', '3/3 确认安装结果…'),
  }
  const seconds = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
  return (
    <span
      data-testid="plugins-reconciliation-status"
      data-stage={stage}
      className="inline-flex flex-wrap items-center gap-x-2 text-sm text-text-secondary"
    >
      <span role="status">{labels[stage]}</span>
      <span aria-live="off" className="text-text-muted">
        {t('workbench.plugins_reconciliation_elapsed', '已用时 {{seconds}} 秒', { seconds })}
      </span>
    </span>
  )
}
