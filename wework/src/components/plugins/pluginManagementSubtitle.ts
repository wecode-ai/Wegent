import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'

function buildShareScopeSubtitle(
  deptCount: number,
  userCount: number,
  t: (key: string, fallback: string) => string
): string {
  if (deptCount === 0 && userCount === 0) {
    return t('workbench.plugins_share_only_self', '仅自己可用')
  }
  const parts: string[] = []
  if (deptCount > 0) {
    parts.push(`${deptCount} ${t('workbench.plugins_share_department_unit', '个部门')}`)
  }
  if (userCount > 0) {
    parts.push(`${userCount} ${t('workbench.plugins_share_member_unit', '名成员')}`)
  }
  return `${t('workbench.plugins_share_specified_members', '指定成员可用')} · ${parts.join(' · ')}`
}

export function buildInstalledPluginSubtitle(
  plugin: InstalledPluginItem,
  marketplaceItem: PluginMarketplaceItem | undefined,
  t: (key: string, fallback: string) => string
): string {
  if (marketplaceItem?.accessRole === 'recipient') {
    const creator =
      marketplaceItem.ownerDisplayName?.trim() || t('workbench.plugins_unknown_creator', '未知')
    return [
      `${t('workbench.plugins_shared_creator', '创建者')} ${creator}`,
      t('workbench.plugins_shared_targeted', '定向分享'),
      t('workbench.plugins_shared_use_only', '仅可使用'),
    ].join(' · ')
  }

  if (plugin.origin === 'created') {
    if (marketplaceItem?.accessRole === 'owner' && marketplaceItem.visibility === 'personal') {
      return buildShareScopeSubtitle(
        marketplaceItem.grantNamespaceCount ?? 0,
        marketplaceItem.grantUserCount ?? 0,
        t
      )
    }
    return t('workbench.plugins_share_only_self', '仅自己可用')
  }

  if (marketplaceItem?.accessRole === 'owner' && marketplaceItem.visibility === 'personal') {
    return buildShareScopeSubtitle(
      marketplaceItem.grantNamespaceCount ?? 0,
      marketplaceItem.grantUserCount ?? 0,
      t
    )
  }

  const componentLabels = Object.entries(plugin.componentCounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} ${count}`)

  return plugin.description || componentLabels.join(' · ')
}
