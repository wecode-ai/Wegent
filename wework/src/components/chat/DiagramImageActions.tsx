import type { ComponentProps } from 'react'
import { DiagramImageActions as SharedDiagramImageActions } from '@wegent/collaboration/markdown/DiagramImageActions'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { useDesktopMarkdownServices } from './useDesktopMarkdownServices'

export function DiagramImageActions(props: ComponentProps<typeof SharedDiagramImageActions>) {
  return (
    <MarkdownServicesProvider value={useDesktopMarkdownServices()}>
      <SharedDiagramImageActions {...props} />
    </MarkdownServicesProvider>
  )
}
