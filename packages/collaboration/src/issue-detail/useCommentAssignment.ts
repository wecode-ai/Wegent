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

export function useCommentAssignment(
  value: string,
  assignment: CommentAssignment | undefined,
  onSubmit: (
    body: string,
    mentions: IssueMentionOption[],
  ) => void | boolean | Promise<void | boolean>,
) {
  const [manualTarget, setManualTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const options = assignment?.options ?? []
  const mentioned = issueCommentSubmission(value).mentions.find(
    mention =>
      mention.type === 'user' &&
      options.some(option => option.value === mention.id),
  )
  const target = assignment ? (manualTarget ?? mentioned?.id ?? '') : ''

  async function submit(draft: string) {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const { body, mentions } = issueCommentSubmission(draft)
      if (body && (await onSubmit(body, mentions)) === false) return
      if (target && assignment) {
        // Keep the target after the host clears a successfully persisted comment.
        setManualTarget(target)
        await assignment.assign(target)
      }
      setManualTarget(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  function setTarget(next: string) {
    setError(null)
    setManualTarget(next)
  }

  return { options, target, setTarget, busy, error, submit }
}
