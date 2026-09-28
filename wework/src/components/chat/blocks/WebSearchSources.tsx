import type { ComponentProps } from 'react'
import {
  WebSearchActivityRows as SharedWebSearchActivityRows,
  WebSearchSourcesChip as SharedWebSearchSourcesChip,
} from '@wegent/collaboration/conversation'
import { DesktopToolServices } from '../DesktopToolServices'

export function WebSearchActivityRows(props: ComponentProps<typeof SharedWebSearchActivityRows>) {
  return (
    <DesktopToolServices>
      <SharedWebSearchActivityRows {...props} />
    </DesktopToolServices>
  )
}

export function WebSearchSourcesChip(props: ComponentProps<typeof SharedWebSearchSourcesChip>) {
  return (
    <DesktopToolServices>
      <SharedWebSearchSourcesChip {...props} />
    </DesktopToolServices>
  )
}
