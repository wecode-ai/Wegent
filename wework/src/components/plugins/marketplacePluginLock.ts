import type { PluginMarketplaceItem } from '@/types/api'

export type MarketplacePluginLockKind = 'plan_not_eligible' | 'disabled_by_admin' | 'not_available'

export type MarketplacePluginLock = {
  kind: MarketplacePluginLockKind
}

function manifestString(item: PluginMarketplaceItem, key: string): string {
  const value = item.manifest?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Codex remote plugins expose availability separately from installed/enabled.
 * DISABLED_BY_ADMIN (+ plan_not_eligible) should lock the install CTA like Codex.
 */
export function resolveMarketplacePluginLock(
  item: PluginMarketplaceItem
): MarketplacePluginLock | null {
  if (item.installed) return null

  const availability = manifestString(item, 'availability').toUpperCase()
  const installPolicy = manifestString(item, 'installPolicy').toUpperCase()
  const disabledReason = manifestString(item, 'disabledReason').toLowerCase()

  if (availability === 'DISABLED_BY_ADMIN') {
    if (disabledReason === 'plan_not_eligible' || disabledReason === 'plan-not-eligible') {
      return { kind: 'plan_not_eligible' }
    }
    return { kind: 'disabled_by_admin' }
  }

  if (installPolicy === 'NOT_AVAILABLE') {
    if (disabledReason === 'plan_not_eligible' || disabledReason === 'plan-not-eligible') {
      return { kind: 'plan_not_eligible' }
    }
    return { kind: 'not_available' }
  }

  return null
}

export function marketplacePluginLockLabel(
  lock: MarketplacePluginLock,
  t: (key: string, defaultValue: string) => string
): string {
  if (lock.kind === 'plan_not_eligible') {
    return t('workbench.plugins_plan_not_supported', '你的套餐不支持')
  }
  if (lock.kind === 'not_available') {
    return t('workbench.plugins_install_not_available', '当前不可安装')
  }
  return t('workbench.plugins_disabled_by_admin', '管理员已禁用')
}
