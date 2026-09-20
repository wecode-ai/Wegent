import type { ComponentProps } from 'react'
import { ComposerLinkChip as SharedComposerLinkChip } from '@wegent/collaboration/markdown/ComposerLinkChip'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { useDesktopMarkdownServices } from './useDesktopMarkdownServices'

export function ComposerLinkChip(props: ComponentProps<typeof SharedComposerLinkChip>) {
  return (
    <MarkdownServicesProvider value={useDesktopMarkdownServices()}>
      <SharedComposerLinkChip {...props} />
    </MarkdownServicesProvider>
  )
}
export type { ComposerLinkChipPayload } from '@wegent/collaboration/markdown/ComposerLinkChip'
