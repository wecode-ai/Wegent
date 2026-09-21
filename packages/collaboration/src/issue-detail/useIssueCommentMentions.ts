import { useEffect, useMemo, useRef, useState } from 'react'
import {
  filterIssueMentionOptions,
  findIssueMentionQuery,
  insertIssueMentionText,
  pruneIssueMentionSelections,
  type IssueMentionGroup,
  type IssueMentionOption,
  type IssueMentionQuery,
  type IssueMentionSelection,
} from './issueCommentMentions'

/**
 * Shared "@"-mention behavior for the issue comment and reply composers.
 *
 * The composers render `groups` through `IssueMentionPopup`; the hook owns query
 * detection, the keyboard highlight, insertion bookkeeping and the structured
 * mentions returned on submit.
 */
export function useIssueCommentMentions({
  mentionGroups,
}: {
  mentionGroups?: IssueMentionGroup[]
}) {
  const selections = useRef<IssueMentionSelection[]>([])
  const [query, setQuery] = useState<IssueMentionQuery | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
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
  /** Popup sections filtered down to the candidates matching the query. */
  const visibleGroups = useMemo(
    () =>
      groups
        .map(group => ({
          ...group,
          items: group.items.filter(item =>
            candidates.some(
              (candidate: IssueMentionOption) =>
                candidate.type === item.mention?.type && candidate.id === item.mention?.id
            )
          ),
        }))
        .filter(group => group.items.length > 0),
    [candidates, groups]
  )
  const rows = useMemo(
    () => visibleGroups.flatMap(group => group.items),
    [visibleGroups]
  )
  const open = query !== null && rows.length > 0
  const highlightedIndex = rows.findIndex(row => row.id === highlightedId)

  // Keep one row highlighted while the popup is open so Enter and Tab have a
  // target without requiring the user to reach for the mouse.
  useEffect(() => {
    if (!open) return
    if (highlightedId && rows.some(row => row.id === highlightedId)) return
    setHighlightedId(rows[0]?.id ?? null)
  }, [highlightedId, open, rows])

  /** Drop targets whose "@label" text the draft no longer contains. */
  const prune = (nextValue: string) => {
    selections.current = pruneIssueMentionSelections(
      nextValue,
      selections.current
    )
  }

  return {
    /** Popup is open when a live query matches at least one target. */
    open,
    candidates,
    groups: visibleGroups,
    rows,
    /** Index of the highlighted row, defaulting to the first candidate. */
    highlightedIndex: highlightedIndex >= 0 ? highlightedIndex : 0,
    /** The row Enter or Tab inserts. */
    highlighted: rows[highlightedIndex >= 0 ? highlightedIndex : 0] ?? null,
    /** Move the highlight through the visible rows, wrapping at both ends. */
    moveHighlight(delta: number) {
      if (rows.length === 0) return
      const current = highlightedIndex >= 0 ? highlightedIndex : 0
      const next = (current + delta + rows.length) % rows.length
      setHighlightedId(rows[next].id)
    },
    /** Follow the pointer so hovering and keyboard selection agree. */
    highlight(id: string) {
      setHighlightedId(id)
    },
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
    insert(
      target: IssueMentionOption,
      currentValue: string,
      caret: number,
      selectionEnd: number
    ) {
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
