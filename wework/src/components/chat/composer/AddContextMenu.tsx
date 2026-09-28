import {
  AddContextMenu as SharedAddContextMenu,
  type AddContextMenuProps,
} from '@wegent/collaboration/composer'
import { useTranslation } from '@/hooks/useTranslation'
export function AddContextMenu(props: Omit<AddContextMenuProps, 'translate'>) {
  const { t } = useTranslation('common')
  return (
    <SharedAddContextMenu
      {...props}
      translate={(key, fallback, options) => t(key, fallback ?? key, options)}
    />
  )
}
