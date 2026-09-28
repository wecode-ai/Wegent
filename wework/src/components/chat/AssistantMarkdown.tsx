import { useCallback } from 'react'
import {
  AssistantMarkdown as SharedAssistantMarkdown,
  MarkdownServicesProvider,
  type AssistantMarkdownProps as SharedAssistantMarkdownProps,
} from '@wegent/collaboration/markdown'
import { CodexInlineVisualizationHost } from './CodexInlineVisualizationHost'
import { useDesktopMarkdownServices } from './useDesktopMarkdownServices'
import type { TurnFileChangesSummary } from '@/types/api'

type AssistantMarkdownProps = Omit<SharedAssistantMarkdownProps, 'renderVisualization'> & {
  fileChanges?: TurnFileChangesSummary
}

export function AssistantMarkdown({ fileChanges, ...props }: AssistantMarkdownProps) {
  const services = useDesktopMarkdownServices()
  const renderVisualization = useCallback(
    (part: { file: string; mode?: 'wide'; title?: string }) => (
      <CodexInlineVisualizationHost {...part} fileChanges={fileChanges} />
    ),
    [fileChanges]
  )
  return (
    <MarkdownServicesProvider value={services}>
      <SharedAssistantMarkdown {...props} renderVisualization={renderVisualization} />
    </MarkdownServicesProvider>
  )
}
