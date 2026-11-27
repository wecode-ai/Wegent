import { useRef, useState } from 'react'
import type { SearchableSelectOption } from '../controls/SearchableSelect'
import type { CommentIssueActions } from './issueCommentActions'
import { issueCommentSubmission, type IssueMentionOption } from './issueCommentMentions'
import { commentAssigneeValue, type IssueAssignmentShortcut } from './issueAssignmentShortcuts'
import type { IssueAssigneeTarget } from './IssueDetailDraft'

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
  shortcuts?: IssueAssignmentShortcut[]
  currentAssignee?: string
  canAssignCurrent?: boolean
  assignmentBusy?: boolean
  assignmentSuccessRevision?: number
  assign(target: string): Promise<void | boolean>
  createChild?(input: CommentChildInput): Promise<import('../types').CollaborationIssue | false>
}

function firstAssignableMention(mentions: IssueMentionOption[], options: SearchableSelectOption[]) {
  return (
    mentions
      .map(mention => (mention.type === 'user' ? mention.id : `agent:${mention.id}`))
      .find(target => options.some(option => option.value === target && !option.disabled)) ?? ''
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
  const [shortcutOrigin, setShortcutOrigin] = useState<{
    value: string
    currentTarget?: IssueAssigneeTarget
    historyIndex?: number
  } | null>(null)
  const [moveTarget, setMoveTarget] = useState('')
  const [closeSelected, setCloseSelected] = useState(false)
  const closeWithComment = closeSelected && actions?.canToggle === true && !actions.closed
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
  const [failure, setFailure] = useState<{
    message: string
    assignmentRevision?: number
  } | null>(null)
  const assignmentRevision = assignment?.assignmentSuccessRevision
  const latestAssignmentRevision = useRef(assignmentRevision)
  latestAssignmentRevision.current = assignmentRevision
  const staleAssignmentFailure =
    failure?.assignmentRevision !== undefined &&
    assignmentRevision !== undefined &&
    assignmentRevision > failure.assignmentRevision
  if (staleAssignmentFailure) setFailure(null)
  const error = staleAssignmentFailure ? null : (failure?.message ?? null)
  const submitting = useRef(false)
  const options = assignment?.options ?? []
  const target = assignment ? selectedTarget : ''
  const mentions = issueCommentSubmission(value).mentions
  const mentioned = firstAssignableMention(mentions, options)
  const focused =
    options.some(option => option.value === focusedSuggestion && !option.disabled) &&
    mentions.some(
      mention =>
        (mention.type === 'user' ? mention.id : `agent:${mention.id}`) === focusedSuggestion
    )
      ? focusedSuggestion
      : ''
  const candidate = focused || mentioned || (!value.trim() ? sentSuggestion : '')
  const selectedShortcut = assignment?.shortcuts?.find(
    shortcut =>
      shortcut.kind !== 'recent' &&
      shortcut.value === target &&
      (shortcutOrigin?.value !== target ||
        ((shortcutOrigin.currentTarget === undefined ||
          shortcut.currentTarget === shortcutOrigin.currentTarget) &&
          (shortcutOrigin.historyIndex === undefined ||
            shortcut.historyIndex === shortcutOrigin.historyIndex)))
  )
  const invalidTarget =
    target !== '' &&
    (target.startsWith('redeliver:') || target.startsWith('return:')
      ? effectiveMode !== 'current' || !selectedShortcut
      : !options.some(option => option.value === target && !option.disabled))
  const assignmentBlocked =
    (invalidTarget && (effectiveMode === 'current' || !closeWithComment)) ||
    (assignment?.assignmentBusy === true &&
      effectiveMode === 'current' &&
      (target !== '' || actions?.assigneeMoves?.includes(moveTarget) === true))
  const selectedAssignee = selectedShortcut ? commentAssigneeValue(selectedShortcut.target) : target
  const suggestion =
    candidate !== selectedAssignee && candidate !== dismissedSuggestion
      ? options.find(option => option.value === candidate && !option.disabled)
      : undefined

  function setTarget(next: string) {
    setFailure(null)
    setSelectedTarget(next)
    const nextShortcut = assignment?.shortcuts?.find(
      shortcut => shortcut.kind !== 'recent' && shortcut.value === next
    )
    setShortcutOrigin(
      nextShortcut
        ? {
            value: next,
            currentTarget: nextShortcut.currentTarget,
            historyIndex: nextShortcut.historyIndex,
          }
        : null
    )
    if (pendingChild && (childCancelled || invalidTarget)) {
      setPendingChild({ ...pendingChild, target: next })
      setChildCancelled(true)
    }
    if (next && actions?.assigneeMoves?.includes(moveTarget)) setMoveTarget('')
    if (!next && !moveTarget && !closeWithComment) clearCommittedComment()
  }

  function setMove(next: string) {
    setFailure(null)
    setMoveTarget(next)
    if (actions?.assigneeMoves?.includes(next)) {
      setSelectedTarget('')
      setShortcutOrigin(null)
    }
    if (!next && !target && !closeWithComment) clearCommittedComment()
  }

  function clearCommittedComment() {
    committedBody.current = null
    setCommentCommitted(false)
  }

  function setMode(next: 'current' | 'child') {
    if (next === effectiveMode) return
    setAssignmentMode(next)
    setCloseSelected(false)
    setSelectedTarget('')
    setShortcutOrigin(null)
    setFocusedSuggestion('')
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

  function selectCloseWithComment(selected: boolean) {
    setFailure(null)
    setCloseSelected(selected)
  }

  async function submit(draft: string) {
    if (submitting.current || assignmentBlocked) return
    const { body, mentions } = issueCommentSubmission(draft)
    const creatingChild = effectiveMode === 'child' && !closeWithComment
    const currentTarget = effectiveMode === 'child' && !creatingChild ? '' : target
    if (
      creatingChild
        ? !body && !pendingChild
        : closeWithComment
          ? !body && !commentCommitted
          : !body && !currentTarget && !moveTarget
    )
      return
    if (currentTarget && assignment?.canAssignCurrent === false && !creatingChild) return
    submitting.current = true
    setBusy(true)
    setFailure(null)
    let assignmentStage = false
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
        setShortcutOrigin(null)
        setSentSuggestion('')
        clearCommittedComment()
        return
      }
      if (body && committedBody.current !== body) {
        const result =
          actions && (currentTarget || moveTarget || closeWithComment)
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
      if (moveTarget && actions) {
        assignmentStage = actions.assigneeMoves?.includes(moveTarget) === true
        if ((await actions.move(moveTarget)) === false) return
        assignmentStage = false
        setMoveTarget('')
      }
      if (closeWithComment && actions) {
        await actions.toggle(true)
        setCloseSelected(false)
      }
      if (currentTarget && assignment) {
        // Commit Issue changes before dispatch so the assignee can read the updated state.
        assignmentStage = true
        if ((await assignment.assign(currentTarget)) === false) return
        setSelectedTarget('')
        setShortcutOrigin(null)
        setSentSuggestion('')
      }
      clearCommittedComment()
    } catch (cause) {
      setFailure({
        message: cause instanceof Error ? cause.message : String(cause),
        assignmentRevision: assignmentStage ? latestAssignmentRevision.current : undefined,
      })
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return {
    mode: effectiveMode,
    setMode,
    pendingChild,
    childTargetLocked: pendingChild !== null && !childCancelled && !invalidTarget,
    options,
    target,
    invalidTarget,
    assignmentBlocked,
    moveTarget,
    setMove,
    closeWithComment,
    selectCloseWithComment,
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
