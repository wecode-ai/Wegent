export type ChatComposerPresentation = 'compact' | 'expanded'

export function chatComposerPresentation(
  focused: boolean,
  hasExpandedContext = false
): ChatComposerPresentation {
  return focused || hasExpandedContext ? 'expanded' : 'compact'
}
