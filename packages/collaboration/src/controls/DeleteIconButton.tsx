import { Trash2 } from 'lucide-react'
import { forwardRef } from 'react'
import { IconButton, type IconButtonProps } from './IconButton'

export type DeleteIconButtonProps = Omit<IconButtonProps, 'tone' | 'children'>

export const DeleteIconButton = forwardRef<
  HTMLButtonElement,
  DeleteIconButtonProps
>(function DeleteIconButton(props, ref) {
  return (
    <IconButton {...props} ref={ref} tone="danger">
      <Trash2 aria-hidden="true" className="h-4 w-4" />
    </IconButton>
  )
})
