import { useRef, useState } from 'react'
import type { SearchableSelectOption } from '../controls/SearchableSelect'
import type { CommentIssueActions } from './issueCommentActions'
import { issueCommentSubmission, type IssueMentionOption } from './issueCommentMentions'

export interface CommentChildInput {
  body: string
  target: string
  requestId: string
  sourceMessageId?: string
}
export interface CommentSubmissionOptions {
  commentOnly?: boolean
}
export interface CommentAssignment {
  options: SearchableSelectOption[]
  canAssignCurrent?: boolean
  assign(target: string): Promise<void | boolean>
  createChild?(input: CommentChildInput): Promise<import('../types').CollaborationIssue | false>
}

function firstAssignableMention(mentions: IssueMentionOption[], options: SearchableSelectOption[]) {
  return (
    mentions
      .map(mention => (mention.type === 'user' ? mention.id : `agent:${mention.id}`))
      .find(target => options.some(option => option.value === target)) ?? ''
  )
}

export function useCommentAssignment(
  value: string,
  assignment: CommentAssignment | undefined,
  onSubmit: (
    body: string,
    mentions: IssueMentionOption[],
    options?: CommentSubmissionOptions
  ) => void | boolean | Promise<void | boolean>,
  actions?: CommentIssueActions
) {
  const [selectedTarget, setSelectedTarget] = useState('')
  const [moveTarget, setMoveTarget] = useState('')
  const [pendingToggle, setPendingToggle] = useState<boolean | null>(null)
  const [commentCommitted, setCommentCommitted] = useState(false)
  const committedBody = useRef<string | null>(null)
  const [mode, setAssignmentMode] = useState<'current' | 'child'>(
    assignment?.canAssignCurrent === false ? 'child' : 'current'
  )
  const effectiveMode = assignment?.createChild ? mode : 'current'
  const [pendingChild, setPendingChild] = useState<CommentChildInput | null>(null)
  const [childCancelled, setChildCancelled] = useState(false)
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
    mention => (mention.type === 'user' ? mention.id : `agent:${mention.id}`) === focusedSuggestion
  )
    ? focusedSuggestion
    : ''
  const candidate = focused || mentioned || (!value.trim() ? sentSuggestion : '')
  const suggestion =
    candidate !== target && candidate !== dismissedSuggestion
      ? options.find(option => option.value === candidate)
      : undefined

  function setTarget(next: string) {
    setError(null)
    setSelectedTarget(next)
    if (childCancelled) setPendingChild(current => (current ? { ...current, target: next } : null))
    if (next && actions?.assigneeMoves?.includes(moveTarget)) setMoveTarget('')
    if (!next && !moveTarget && pendingToggle === null) clearCommittedComment()
  }

  function setMove(next: string) {
    setError(null)
    setMoveTarget(next)
    if (actions?.assigneeMoves?.includes(next)) setSelectedTarget('')
    if (!next && !target && pendingToggle === null) clearCommittedComment()
  }

  function clearCommittedComment() {
    committedBody.current = null
    setCommentCommitted(false)
  }

  function setMode(next: 'current' | 'child') {
    setAssignmentMode(next)
    if (next === 'child') setMoveTarget('')
  }

  function acceptSuggestion() {
    if (suggestion && !submitting.current) setTarget(suggestion.value)
  }

  function dismissSuggestion() {
    setDismissedSuggestion(candidate)
    setSentSuggestion('')
  }

  function suggestReference(reference: string): boolean {
    const next = firstAssignableMention(issueCommentSubmission(reference).mentions, options)
    if (!next || submitting.current) return false
    setFocusedSuggestion(next)
    setDismissedSuggestion('')
    return true
  }

  async function submit(draft: string, closed?: boolean) {
    if (submitting.current) return
    const { body, mentions } = issueCommentSubmission(draft)
    const toggle = closed ?? pendingToggle
    const creatingChild = effectiveMode === 'child' && toggle === null
    const currentTarget = effectiveMode === 'child' && !creatingChild ? '' : target
    if (
      creatingChild
        ? !body && !pendingChild
        : !body && !currentTarget && !moveTarget && toggle === null
    )
      return
    if (currentTarget && assignment?.canAssignCurrent === false && !creatingChild) return
    if (closed !== undefined && !actions?.canToggle) return
    submitting.current = true
    setBusy(true)
    setError(null)
    if (closed !== undefined) setPendingToggle(closed)
    try {
      if (creatingChild) {
        if (!assignment?.createChild) return
        let operation = pendingChild
        if (!operation) {
          if ((await onSubmit(body, mentions, { commentOnly: true })) === false) return
          operation = { body, target, requestId: crypto.randomUUID() }
          setPendingChild(operation)
        }
        setChildCancelled(false)
        if ((await assignment.createChild(operation)) === false) {
          setChildCancelled(true)
          return
        }
        setPendingChild(null)
        setSelectedTarget('')
        setSentSuggestion('')
        clearCommittedComment()
        return
      }
      if (body && committedBody.current !== body) {
        const result =
          actions && (currentTarget || moveTarget || toggle !== null)
            ? await onSubmit(body, mentions, { commentOnly: true })
            : await onSubmit(body, mentions)
        if (result === false) return
        committedBody.current = body
        setCommentCommitted(true)
        const submittedSuggestion = candidate || firstAssignableMention(mentions, options)
        setSentSuggestion(submittedSuggestion === dismissedSuggestion ? '' : submittedSuggestion)
        setDismissedSuggestion('')
        setFocusedSuggestion('')
      }
      if (currentTarget && assignment) {
        // Only an explicitly selected target participates in submission.
        if ((await assignment.assign(currentTarget)) === false) return
        setSelectedTarget('')
        setSentSuggestion('')
      }
      if (moveTarget && actions) {
        if ((await actions.move(moveTarget)) === false) return
        setMoveTarget('')
      }
      if (toggle !== null && actions) {
        await actions.toggle(toggle)
        setPendingToggle(null)
      }
      clearCommittedComment()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return {
    mode: effectiveMode,
    setMode,
    pendingChild,
    childTargetLocked: pendingChild !== null && !childCancelled,
    options,
    target,
    moveTarget,
    setMove,
    pendingToggle,
    commentCommitted,
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
