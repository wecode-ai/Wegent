import { useMemo, useRef, useState } from 'react'
import {
  filterIssueMentionOptions,
  findIssueMentionQuery,
  insertIssueMentionText,
  pruneIssueMentionSelections,
  type IssueMentionQuery,
  type IssueMentionSelection,
} from './issueCommentMentions'
import type { IssueMentionGroup } from './IssueMainCommentComposer'

/**
 * Shared "@"-mention behavior for the issue comment and reply composers.
 *
 * The composers render the popup from `groups`; the hook owns query detection,
 * insertion bookkeeping and the structured mentions returned on submit.
 */
export function useIssueCommentMentions({
  mentionGroups,
}: {
  mentionGroups?: IssueMentionGroup[]
}) {
  const selections = useRef<IssueMentionSelection[]>([])
  const [query, setQuery] = useState<IssueMentionQuery | null>(null)
  const groups = mentionGroups ?? []
  const options = useMemo(
    () =>
      groups.flatMap(group => group.items.flatMap(item => (item.mention ? [item.mention] : []))),
    [groups]
  )
  const candidates = useMemo(
    () =>
      query === null
        ? []
        : filterIssueMentionOptions(
            options,
            query.query,
            selections.current.map(selection => selection.mention)
          ),
    [options, query]
  )

  /** Drop targets whose "@label" text the draft no longer contains. */
  const prune = (nextValue: string) => {
    selections.current = pruneIssueMentionSelections(
      nextValue,
      selections.current
    )
  }

  return {
    /** Popup is open when a live query matches at least one target. */
    open: query !== null && candidates.length > 0,
    candidates,
    /** Filter each popup group down to the candidates matching the query. */
    groups: groups
      .map(group => ({
        ...group,
        items: group.items.filter(item =>
          candidates.some(
            candidate => candidate.type === item.mention?.type && candidate.id === item.mention?.id
          )
        ),
      }))
      .filter(group => group.items.length > 0),
    /** Update the active query from the caret after an input change. */
    handleChange(nextValue: string, caret: number | null) {
      setQuery(findIssueMentionQuery(nextValue, caret))
      prune(nextValue)
    },
    /** Keep the query in sync with caret movement. */
    handleCaret(nextValue: string, caret: number | null) {
      setQuery(findIssueMentionQuery(nextValue, caret))
    },
    close() {
      setQuery(null)
    },
    /** Insert the selected target over the active query range. */
    insert(itemId: string, currentValue: string, caret: number, selectionEnd: number) {
      const target = groups.flatMap(group => group.items).find(item => item.id === itemId)?.mention
      if (!target) return null
      const activeQuery = query ?? { start: caret, query: '' }
      const inserted = insertIssueMentionText(currentValue, activeQuery, target, selectionEnd)
      selections.current = [
        ...selections.current.filter(
          selection =>
            !(selection.mention.type === target.type && selection.mention.id === target.id)
        ),
        inserted.selection,
      ]
      setQuery(null)
      return { value: inserted.value, cursor: inserted.cursor }
    },
    /** The mentions still present in the draft at submit time. */
    submit(nextValue: string) {
      prune(nextValue)
      return selections.current.map(selection => selection.mention)
    },
  }
}
