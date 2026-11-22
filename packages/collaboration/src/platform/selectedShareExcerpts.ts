import type { TaskIssueShareDraft } from './personalIssuesApi'

/** Retain transcript order while making the selected source available in a preview. */
export function selectedShareExcerpts(
  excerpts: TaskIssueShareDraft['excerpts'],
  selection: TaskIssueShareDraft['selectedExcerpt']
): TaskIssueShareDraft['excerpts'] {
  if (!selection) return excerpts
  const existing = excerpts.findIndex(excerpt => excerpt.id === selection.excerpt.id)
  if (existing >= 0)
    return excerpts.map((excerpt, index) => (index === existing ? selection.excerpt : excerpt))
  const following = new Set(selection.followingMessageIds)
  const successor = excerpts.findIndex(excerpt => following.has(excerpt.id))
  const index = successor < 0 ? excerpts.length : successor
  return [...excerpts.slice(0, index), selection.excerpt, ...excerpts.slice(index)]
}
