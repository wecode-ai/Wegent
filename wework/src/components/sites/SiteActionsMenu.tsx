import { useRef } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import type { SiteProject } from '@/api/sites'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'

interface SiteActionsMenuProps {
  site: SiteProject
  disabled: boolean
  onRename: (site: SiteProject) => void
  onDelete: (site: SiteProject, returnFocusContainer: HTMLElement | null) => void
}

export function SiteActionsMenu({ site, disabled, onRename, onDelete }: SiteActionsMenuProps) {
  const { t } = useTranslation('sites')
  const containerRef = useRef<HTMLFieldSetElement>(null)
  const testId = `site-more-${site.id}`
  const triggerClassName =
    'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 md:h-8 md:w-8'

  return (
    <fieldset
      ref={containerRef}
      disabled={disabled}
      className="m-0 min-w-0 shrink-0 border-0 p-0"
      onClickCapture={event => {
        if (!disabled) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <ActionMenu
        ariaLabel={t('more_actions', '更多操作')}
        testId={testId}
        placement="bottom-end"
        triggerClassName={triggerClassName}
        items={[
          {
            label: t('rename_site', '重命名站点'),
            icon: Pencil,
            testId: `site-rename-menu-item-${site.id}`,
            disabled,
            onSelect: () => {
              containerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
              onRename(site)
            },
          },
          {
            label: t('delete_site', '删除站点'),
            icon: Trash2,
            testId: `site-delete-menu-item-${site.id}`,
            danger: true,
            disabled,
            onSelect: () => onDelete(site, containerRef.current),
          },
        ]}
      />
    </fieldset>
  )
}
