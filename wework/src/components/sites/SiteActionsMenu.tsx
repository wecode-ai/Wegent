import { Trash2 } from 'lucide-react'
import type { Site } from '@/api/sites'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'

interface SiteActionsMenuProps {
  site: Site
  disabled: boolean
  onDelete: (site: Site) => void
}

export function SiteActionsMenu({ site, disabled, onDelete }: SiteActionsMenuProps) {
  const { t } = useTranslation('sites')

  return (
    <ActionMenu
      ariaLabel={t('more_actions', '更多操作')}
      testId={`site-more-${site.siteid}`}
      placement="bottom-end"
      triggerClassName="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      items={[
        {
          label: t('delete_site', '删除站点'),
          icon: Trash2,
          testId: `site-delete-menu-item-${site.siteid}`,
          danger: true,
          disabled,
          onSelect: () => onDelete(site),
        },
      ]}
    />
  )
}
