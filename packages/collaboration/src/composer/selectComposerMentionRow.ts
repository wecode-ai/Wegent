import type { RefObject } from 'react'
import type {
  ComposerAutocompleteInputProps,
  ComposerExternalMentionCandidate,
} from './composerAutocompleteInputTypes'
import type { ComposerMentionCandidate } from './composerMentionCandidates'
import type { MentionMenuRow } from './ComposerMentionMenu'
import type { ComposerEditorHandle } from './ComposerProseMirrorEditor'
import type { ComposerTextTrigger } from './composerAutocomplete'
import type { ComposerAutocompleteState } from './composerAutocompleteState'
import {
  createComposerPathReference,
  replaceComposerMentionTrigger,
  resolveComposerWorkspacePath,
} from './composerMentions'

interface MentionActionOptions<Project, Conversation> extends Pick<
  ComposerAutocompleteInputProps<Project, Conversation>,
  | 'onSelectCloudProject'
  | 'onSelectExternalMention'
  | 'onSetGoal'
  | 'onSetPlanMode'
  | 'onDraw'
  | 'onPickWorkspacePaths'
  | 'onPasteFiles'
  | 'workspaceTarget'
> {
  editorRef: RefObject<ComposerEditorHandle | null>
  autocompleteState: ComposerAutocompleteState
  canPickNativeWorkspacePaths: boolean
  closeAutocompleteMenu(): void
  cloudSpaceDirectReference: string
  commitEditorValue(value: string, cursor: number): void
  selectMentionCandidate(
    candidate: ComposerMentionCandidate<Project, Conversation>,
    trigger: ComposerTextTrigger
  ): boolean
  setActionError(message: string | null): void
}

/** Execute the selected mention action against its actual editor and menu state. */
export function selectComposerMentionRow<Project, Conversation>(
  row: MentionMenuRow<
    ComposerMentionCandidate<Project, Conversation>,
    ComposerExternalMentionCandidate
  >,
  explicitTrigger: ComposerTextTrigger | undefined,
  {
    editorRef,
    autocompleteState,
    canPickNativeWorkspacePaths,
    closeAutocompleteMenu,
    cloudSpaceDirectReference,
    commitEditorValue,
    onSelectCloudProject,
    onSelectExternalMention,
    onSetGoal,
    onSetPlanMode,
    onDraw,
    selectMentionCandidate,
    workspaceTarget,
    onPickWorkspacePaths,
    onPasteFiles,
    setActionError,
  }: MentionActionOptions<Project, Conversation>
): boolean {
  const { setCloudProjectsOpen, setSelectedIndex } = autocompleteState

  if (row.kind === 'files-action' && !canPickNativeWorkspacePaths) return false
  const trigger = explicitTrigger ?? autocompleteState.getSnapshot().activeMenu?.trigger
  const editor = editorRef.current
  if (!trigger || !editor) return false
  if (row.kind === 'candidate') {
    if (!row.candidate.enabled) return false
    const selected = selectMentionCandidate(row.candidate, trigger)
    if (selected && row.candidate.kind === 'cloud' && row.candidate.project) {
      onSelectCloudProject?.(row.candidate.project)
    }
    return selected
  }
  if (row.kind === 'external') {
    if (row.candidate.reference) {
      const snapshot = editor.getSnapshot()
      const replacement = replaceComposerMentionTrigger(
        snapshot.value,
        row.candidate.reference,
        trigger.start,
        Math.max(snapshot.selectionEnd, trigger.start + 1 + trigger.query.length)
      )
      commitEditorValue(replacement.value, replacement.cursor)
    }
    onSelectExternalMention?.(row.candidate)
    closeAutocompleteMenu()
    return true
  }
  if (row.kind === 'cloud-projects-action') {
    setCloudProjectsOpen(true)
    setSelectedIndex(0)
    return true
  }
  if (row.kind === 'cloud-back-action') {
    setCloudProjectsOpen(false)
    setSelectedIndex(0)
    return true
  }

  const snapshot = editor.getSnapshot()
  if (row.kind === 'cloud-space-direct-action') {
    const replacement = replaceComposerMentionTrigger(
      snapshot.value,
      cloudSpaceDirectReference,
      trigger.start,
      snapshot.selectionEnd
    )
    commitEditorValue(replacement.value, replacement.cursor)
    closeAutocompleteMenu()
    editor.focus()
    return true
  }
  if (row.kind === 'path') {
    const path = resolveComposerWorkspacePath(row.item.root, row.item.path)
    const reference = createComposerPathReference(path, row.item.matchType === 'directory')
    const replacement = replaceComposerMentionTrigger(
      snapshot.value,
      reference,
      trigger.start,
      snapshot.selectionEnd
    )
    commitEditorValue(replacement.value, replacement.cursor)
    closeAutocompleteMenu()
    editor.focus()
    return true
  }

  const nextValue =
    snapshot.value.slice(0, trigger.start) + snapshot.value.slice(snapshot.selectionEnd)
  commitEditorValue(nextValue, trigger.start)
  closeAutocompleteMenu()
  if (row.kind === 'goal-action') onSetGoal?.()
  if (row.kind === 'plan-action') onSetPlanMode?.()
  if (row.kind === 'draw-action') onDraw?.()
  if (row.kind === 'files-action' && onPickWorkspacePaths) {
    setActionError(null)
    const owningElement = editor.element
    const isCurrentEditor = () => editorRef.current === editor && editor.element === owningElement
    void onPickWorkspacePaths(workspaceTarget?.path)
      .then(async ({ attachmentFiles, referenceEntries }) => {
        const currentEditor = editorRef.current
        if (!currentEditor || !isCurrentEditor()) return
        if (attachmentFiles.length) await onPasteFiles?.(attachmentFiles)
        if (!isCurrentEditor()) return
        if (!referenceEntries.length) {
          currentEditor.focus()
          return
        }
        const references = referenceEntries
          .map(entry => createComposerPathReference(entry.path, entry.isDirectory))
          .join(' ')
        const current = currentEditor.getSnapshot()
        const spacer = current.value && current.selectionOffset > 0 ? ' ' : ''
        const nextValue =
          current.value.slice(0, current.selectionOffset) +
          spacer +
          references +
          ' ' +
          current.value.slice(current.selectionOffset)
        commitEditorValue(
          nextValue,
          current.selectionOffset + spacer.length + references.length + 1
        )
        currentEditor.focus()
      })
      .catch(error => {
        if (isCurrentEditor())
          setActionError(error instanceof Error ? error.message : String(error))
      })
  }
  editor.focus()
  return true
}
