import type { ComponentProps } from 'react'
import { FileChangesCard as SharedFileChangesCard } from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'

export function FileChangesCard(props: ComponentProps<typeof SharedFileChangesCard>) {
  return (
    <DesktopConversationTranslation>
      <SharedFileChangesCard {...props} />
    </DesktopConversationTranslation>
  )
}
