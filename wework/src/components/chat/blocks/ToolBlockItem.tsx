import type { ComponentProps } from 'react'
import { ToolBlockItem as SharedToolBlockItem } from '@wegent/collaboration/conversation'
import { DesktopToolServices } from '../DesktopToolServices'

export function ToolBlockItem(props: ComponentProps<typeof SharedToolBlockItem>) {
  return (
    <DesktopToolServices>
      <SharedToolBlockItem {...props} />
    </DesktopToolServices>
  )
}

export type { FileEditDuration, FileEditDurationsByBlock } from '@wegent/collaboration/conversation'
