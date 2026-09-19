import { useMemo, useRef, useState } from 'react'
import {
  filterIssueMentionOptions,
  findIssueMentionQuery,
  insertIssueMentionText,
  pruneIssueMentionSelections,
  type IssueMentionOption,
  type IssueMentionQuery,
  type IssueMentionSelection,
} from './issueCommentMentions'
import type { IssueMentionGroup } from './IssueMainCommentComposer'

/**
 * Shared "@"-mention behavior for the issue comment and reply composers.
 *
 * The composers render the popup from `groups`; the hook owns query detection,
 * insertion bookkeeping and the structured mentions reported on submit.
 */
export function useIssueCommentMentions({
  mentionGroups,
  onMentionsChange,
}: {
  mentionGroups?: IssueMentionGroup[]
  onMentionsChange?(mentions: IssueMentionOption[]): void
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

  const emit = (next: IssueMentionSelection[]) => {
    selections.current = next
    onMentionsChange?.(next.map(selection => selection.mention))
  }

  const syncValue = (nextValue: string) => {
    const pruned = pruneIssueMentionSelections(nextValue, selections.current)
    if (pruned.length !== selections.current.length) emit(pruned)
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
      syncValue(nextValue)
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
      emit([
        ...selections.current.filter(
          selection =>
            !(selection.mention.type === target.type && selection.mention.id === target.id)
        ),
        inserted.selection,
      ])
      setQuery(null)
      return { value: inserted.value, cursor: inserted.cursor }
    },
    /** Report and return the mentions still present on submit. */
    submit(nextValue: string) {
      const pruned = pruneIssueMentionSelections(nextValue, selections.current)
      emit(pruned)
      return pruned.map(selection => selection.mention)
    },
  }
}
