import { KeyRound, Pencil, ShieldCheck, Trash2, Upload, UserRoundPlus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Site } from '@/api/sites'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'

interface SiteActionsMenuProps {
  site: Site
  disabled: boolean
  canPublish: boolean
  publishDisabled: boolean
  publishLabel: string
  publishIcon?: LucideIcon
  canEdit: boolean
  canConfigureEnvironment: boolean
  canDelete: boolean
  canManageCollaborators: boolean
  canManageAccess: boolean
  onPublish: (site: Site) => void
  onEdit: (site: Site) => void
  onConfigureEnvironment: (site: Site) => void
  onDelete: (site: Site) => void
  onManageCollaborators: (site: Site) => void
  onManageAccess: (site: Site) => void
}

export function SiteActionsMenu({
  site,
  disabled,
  canPublish,
  publishDisabled,
  publishLabel,
  publishIcon: PublishIcon = Upload,
  canEdit,
  canConfigureEnvironment,
  canDelete,
  canManageCollaborators,
  canManageAccess,
  onPublish,
  onEdit,
  onConfigureEnvironment,
  onDelete,
  onManageCollaborators,
  onManageAccess,
}: SiteActionsMenuProps) {
  const { t } = useTranslation('sites')
  const items = [
    ...(canEdit
      ? [
          {
            label: t('edit_site', '编辑站点'),
            icon: Pencil,
            testId: `site-edit-menu-item-${site.siteid}`,
            disabled,
            onSelect: () => onEdit(site),
          },
        ]
      : []),
    ...(canConfigureEnvironment
      ? [
          {
            label: t('environment_variables', '环境变量'),
            icon: KeyRound,
            testId: `site-environment-menu-item-${site.siteid}`,
            disabled,
            onSelect: () => onConfigureEnvironment(site),
          },
        ]
      : []),
    ...(canManageCollaborators
      ? [
          {
            label: t('manage_collaborators', '管理协作者'),
            icon: UserRoundPlus,
            testId: `site-collaborators-menu-item-${site.siteid}`,
            disabled,
            onSelect: () => onManageCollaborators(site),
          },
        ]
      : []),
    ...(canManageAccess
      ? [
          {
            label: t('manage_access', '访问权限'),
            icon: ShieldCheck,
            testId: `site-access-menu-item-${site.siteid}`,
            disabled,
            onSelect: () => onManageAccess(site),
          },
        ]
      : []),
    ...(canPublish
      ? [
          {
            label: publishLabel,
            icon: PublishIcon,
            testId: `site-publish-${site.siteid}`,
            disabled: disabled || publishDisabled,
            onSelect: () => onPublish(site),
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            label: t('delete_site', '删除站点'),
            icon: Trash2,
            testId: `site-delete-menu-item-${site.siteid}`,
            danger: true,
            disabled,
            onSelect: () => onDelete(site),
          },
        ]
      : []),
  ]

  return (
    <ActionMenu
      ariaLabel={t('more_actions', '更多操作')}
      testId={`site-more-${site.siteid}`}
      placement="bottom-end"
      triggerClassName="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      items={items}
    />
  )
}
