import { lazy } from 'react'
import type { AssistantMarkdownProps } from './AssistantMarkdownRenderer'

export type { AssistantMarkdownProps } from './AssistantMarkdownRenderer'

const AssistantMarkdownRenderer = lazy(() =>
  import('./AssistantMarkdownRenderer').then(module => ({
    default: module.AssistantMarkdown,
  }))
)

export function AssistantMarkdown(props: AssistantMarkdownProps) {
  return <AssistantMarkdownRenderer {...props} />
}
