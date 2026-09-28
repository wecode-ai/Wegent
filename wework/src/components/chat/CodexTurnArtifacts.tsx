import type { ComponentProps } from 'react'
import {
  CodexMemoryCitations as SharedCodexMemoryCitations,
  CodexReferenceList as SharedCodexReferenceList,
} from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'

export function CodexMemoryCitations(props: ComponentProps<typeof SharedCodexMemoryCitations>) {
  return (
    <DesktopConversationTranslation>
      <SharedCodexMemoryCitations {...props} />
    </DesktopConversationTranslation>
  )
}
export function CodexReferenceList(props: ComponentProps<typeof SharedCodexReferenceList>) {
  return (
    <DesktopConversationTranslation>
      <SharedCodexReferenceList {...props} />
    </DesktopConversationTranslation>
  )
}
