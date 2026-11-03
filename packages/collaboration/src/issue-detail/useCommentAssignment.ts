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
  const [manualTarget, setManualTarget] = useState<string | null>(null)
  const [sentTarget, setSentTarget] = useState('')
  const [confirmedDraft, setConfirmedDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const options = assignment?.options ?? []
  const mentionedTarget = firstAssignableMention(
    issueCommentSubmission(value).mentions,
    options,
  )
  const suggestion =
    value === confirmedDraft
      ? ''
      : mentionedTarget || (!value.trim() ? sentTarget : '')
  const target = assignment ? (manualTarget ?? suggestion) : ''

  async function submit(draft: string) {
    if (submitting.current) return
    const { body, mentions } = issueCommentSubmission(draft)
    if (!body) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      if ((await onSubmit(body, mentions)) === false) return
      // Sending a mention only preserves a suggestion; it never transfers ownership.
      setSentTarget(
        manualTarget ?? (firstAssignableMention(mentions, options) || target),
      )
      setManualTarget(null)
      setConfirmedDraft(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  async function confirm(): Promise<boolean> {
    if (submitting.current || !target || !assignment) return false
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await assignment.assign(target)
      setManualTarget(null)
      setSentTarget('')
      setConfirmedDraft(value)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  function setTarget(next: string) {
    setError(null)
    setManualTarget(next)
  }

  return { options, target, setTarget, busy, error, submit, confirm }
}
