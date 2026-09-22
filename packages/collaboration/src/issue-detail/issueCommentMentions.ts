import type { ProjectChatMention } from '@wegent/chat-core'

/**
 * A structured "@" target: the picker shows `name`, and the comment carries the
 * member or robot it stands for.
 */
export interface IssueMentionOption {
  type: 'user' | 'agent'
  id: string
  label: string
}

/** One popup section: the members and robots a composer can mention. */
export interface IssueMentionGroup {
  label: string
  items: {
    id: string
    name: string
    avatar?: string
    testId?: string
    mention?: IssueMentionOption
  }[]
}

/** Whether two targets stand for the same member or robot. */
export function sameIssueMention(
  left: IssueMentionOption,
  right: IssueMentionOption
): boolean {
  return left.type === right.type && left.id === right.id
}

/**
 * Write a target's "@label" over the caret, replacing the "@" that opened the
 * picker, and return the draft with the caret that follows the mention.
 */
export function insertIssueMention(
  draft: string,
  start: number,
  end: number,
  name: string
): { value: string; caret: number } {
  const prefix = draft.slice(0, start).replace(/@$/, '')
  const suffix = draft.slice(end)
  const leading = prefix && !/\s$/.test(prefix) ? ' ' : ''
  const trailing = suffix && /^\s/.test(suffix) ? '' : ' '
  const insertion = `${prefix}${leading}@${name}${trailing}`
  return { value: `${insertion}${suffix}`, caret: insertion.length }
}

/**
 * The mentions a submitted comment carries.
 *
 * A pick only counts while its "@label" is still in the draft — deleting the
 * text removes the mention — and picking one target twice counts once.
 */
export function issueMentionPayload(
  draft: string,
  picked: IssueMentionOption[]
): ProjectChatMention[] {
  const seen = new Set<string>()
  const mentions: ProjectChatMention[] = []
  for (const option of picked) {
    if (!draft.includes(`@${option.label}`)) continue
    const key = `${option.type}:${option.id}`
    if (seen.has(key)) continue
    seen.add(key)
    mentions.push({ type: option.type, id: option.id, label: option.label })
  }
  return mentions
}
