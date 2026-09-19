import type { ProjectChatMention } from '@wegent/chat-core'

/** A structured "@" target offered by the issue comment composer. */
export interface IssueMentionOption {
  type: 'user' | 'agent'
  id: string
  label: string
}

/** One mentioned target that has been inserted into the current comment. */
export interface IssueMentionSelection {
  mention: IssueMentionOption
  start: number
}

export interface IssueMentionQuery {
  start: number
  query: string
}

const MENTION_BOUNDARY = /[\s@]/

/**
 * Return the active "@query" range ending at the caret, or null.
 *
 * A completed mention is followed by a space, so text after that space can no
 * longer extend the query.
 */
export function findIssueMentionQuery(
  value: string,
  caret: number | null
): IssueMentionQuery | null {
  if (caret === null || caret < 0 || caret > value.length) return null
  const start = value.lastIndexOf('@', caret - 1)
  if (start < 0) return null
  const query = value.slice(start + 1, caret)
  if (MENTION_BOUNDARY.test(query)) return null
  return { start, query }
}

/** Filter the mention popup by the active query. */
export function filterIssueMentionOptions(
  options: IssueMentionOption[],
  query: string,
  exclude: IssueMentionOption[] = []
): IssueMentionOption[] {
  const normalized = query.trim().toLowerCase()
  return options.filter(
    option =>
      !exclude.some(item => item.type === option.type && item.id === option.id) &&
      (normalized.length === 0 || option.label.toLowerCase().includes(normalized))
  )
}

/**
 * Insert "@label " over the active query range.
 *
 * The caller tracks the returned start offset so deleting the mention removes
 * the structured target with it.
 */
export function insertIssueMentionText(
  value: string,
  query: IssueMentionQuery,
  option: IssueMentionOption,
  caret: number
): { value: string; cursor: number; selection: IssueMentionSelection } {
  const inserted = `@${option.label} `
  return {
    value: value.slice(0, query.start) + inserted + value.slice(caret),
    cursor: query.start + inserted.length,
    selection: { mention: option, start: query.start },
  }
}

/** Drop selections whose "@label" text is no longer present in the draft. */
export function pruneIssueMentionSelections(
  value: string,
  selections: IssueMentionSelection[]
): IssueMentionSelection[] {
  return selections.filter(selection => value.includes(`@${selection.mention.label}`))
}

/** Convert inserted selections into the wire payload, newest last. */
export function issueMentionPayload(selections: IssueMentionSelection[]): ProjectChatMention[] {
  const seen = new Set<string>()
  const mentions: ProjectChatMention[] = []
  for (const selection of selections) {
    const { type, id, label } = selection.mention
    const key = `${type}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    mentions.push({ type, id, label })
  }
  return mentions
}
