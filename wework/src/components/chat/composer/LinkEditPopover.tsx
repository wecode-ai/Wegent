import type { ComponentProps } from 'react'
import { LinkEditPopover as SharedLinkEditPopover } from '@wegent/collaboration/composer'
import { DesktopToolServices } from '../DesktopToolServices'

export function LinkEditPopover(props: ComponentProps<typeof SharedLinkEditPopover>) {
  return (
    <DesktopToolServices>
      <SharedLinkEditPopover {...props} />
    </DesktopToolServices>
  )
}
