import type { ComponentProps } from 'react'
import {
  SubagentActivityGroup as SharedSubagentActivityGroup,
  SubagentAvatar as SharedSubagentAvatar,
} from '@wegent/collaboration/conversation'
import { DesktopToolServices } from '../DesktopToolServices'

export function SubagentActivityGroup(props: ComponentProps<typeof SharedSubagentActivityGroup>) {
  return (
    <DesktopToolServices>
      <SharedSubagentActivityGroup {...props} />
    </DesktopToolServices>
  )
}

export function SubagentAvatar(props: ComponentProps<typeof SharedSubagentAvatar>) {
  return (
    <DesktopToolServices>
      <SharedSubagentAvatar {...props} />
    </DesktopToolServices>
  )
}
