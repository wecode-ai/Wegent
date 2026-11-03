import { useRef, useState } from 'react'
import type { IssueDetailSearchableSelectOption } from './IssueDetailControls'
import {
  issueCommentSubmission,
  type IssueMentionOption,
} from './issueCommentMentions'

export interface CommentAssignment {
  options: IssueDetailSearchableSelectOption[]
  assign(target: string): Promise<void>
}

function firstAssignableMention(
  mentions: IssueMentionOption[],
  options: IssueDetailSearchableSelectOption[],
) {
  return (
    mentions
      .map(mention =>
        mention.type === 'user' ? mention.id : `agent:${mention.id}`,
      )
      .find(target => options.some(option => option.value === target)) ?? ''
  )
}

export function useCommentAssignment(
  value: string,
  assignment: CommentAssignment | undefined,
  onSubmit: (
    body: string,
    mentions: IssueMentionOption[],
  ) => void | boolean | Promise<void | boolean>,
) {
  const [selectedTarget, setSelectedTarget] = useState('')
  const [sentSuggestion, setSentSuggestion] = useState('')
  const [dismissedSuggestion, setDismissedSuggestion] = useState('')
  const [focusedSuggestion, setFocusedSuggestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const options = assignment?.options ?? []
  const target = assignment ? selectedTarget : ''
  const mentions = issueCommentSubmission(value).mentions
  const mentioned = firstAssignableMention(mentions, options)
  const focused = mentions.some(
    mention =>
      (mention.type === 'user' ? mention.id : `agent:${mention.id}`) ===
      focusedSuggestion,
  )
    ? focusedSuggestion
    : ''
  const candidate =
    focused || mentioned || (!value.trim() ? sentSuggestion : '')
  const suggestion =
    candidate !== target && candidate !== dismissedSuggestion
      ? options.find(option => option.value === candidate)
      : undefined

  function setTarget(next: string) {
    setError(null)
    setSelectedTarget(next)
  }

  function acceptSuggestion() {
    if (suggestion && !submitting.current) setTarget(suggestion.value)
  }

  function dismissSuggestion() {
    setDismissedSuggestion(candidate)
    setSentSuggestion('')
  }

  function suggestReference(reference: string): boolean {
    const next = firstAssignableMention(
      issueCommentSubmission(reference).mentions,
      options,
    )
    if (!next || submitting.current) return false
    setFocusedSuggestion(next)
    setDismissedSuggestion('')
    return true
  }

  async function submit(draft: string) {
    if (submitting.current) return
    const { body, mentions } = issueCommentSubmission(draft)
    if (!body && !target) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      if (body) {
        if ((await onSubmit(body, mentions)) === false) return
        const submittedSuggestion =
          candidate || firstAssignableMention(mentions, options)
        setSentSuggestion(
          submittedSuggestion === dismissedSuggestion
            ? ''
            : submittedSuggestion,
        )
        setDismissedSuggestion('')
        setFocusedSuggestion('')
      }
      if (target && assignment) {
        // Only an explicitly selected target participates in submission.
        await assignment.assign(target)
        setSelectedTarget('')
        setSentSuggestion('')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return {
    options,
    target,
    suggestion,
    setTarget,
    acceptSuggestion,
    dismissSuggestion,
    suggestReference,
    busy,
    error,
    submit,
  }
}
