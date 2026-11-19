import { Editor, type EditorFactory, type EditorType } from '@pierre/diffs/edit'
import type { CodeViewHandle } from '@pierre/diffs/react'
import { publishSelectedTextSelection, writeSelectedTextDragData } from '@/lib/selected-text-drag'

type WorkspaceEditor = Editor<EditorType, undefined, undefined>
type WorkspaceCodeView = CodeViewHandle<undefined, undefined>

function selectedEditorText(editor: WorkspaceEditor): string | null {
  const selection = editor.getViewState().selections?.[0]
  if (!selection) return null
  const text = editor.getText()
  const lines = text.split('\n')
  const offset = (position: { line: number; character: number }) =>
    lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) +
    position.character
  const start = offset(selection.start)
  const end = offset(selection.end)
  return start === end ? null : text.slice(Math.min(start, end), Math.max(start, end))
}

/** Bind selection and line navigation to the actual Pierre view and editor instances. */
export function createWorkspaceCodeEditorPort(path: string) {
  const source = `workspace-editor:${path}`
  let editor: WorkspaceEditor | null = null
  let content: HTMLElement | null = null
  let host: HTMLElement | null = null
  let binding: { view: WorkspaceCodeView } | null = null
  let lineTarget: { lineStart?: number; lineEnd?: number } | null = null
  const setEditor = (next: WorkspaceEditor | null) => {
    content?.removeAttribute('data-testid')
    editor = next
    content = next
      ? (host
          ?.querySelector('diffs-container')
          ?.shadowRoot?.querySelector<HTMLElement>('[data-content][role="textbox"]') ?? null)
      : null
    if (content) content.dataset.testid = 'workspace-file-editor-content'
  }
  const publishSelection = () => {
    if (!binding) return
    const nativeSelection = window.getSelection()
    const rect = nativeSelection?.rangeCount
      ? nativeSelection.getRangeAt(0).getBoundingClientRect()
      : null
    publishSelectedTextSelection(source, editor ? selectedEditorText(editor) : null, rect)
  }
  const reveal = () => {
    const { lineStart, lineEnd } = lineTarget ?? {}
    if (!editor || !Number.isInteger(lineStart) || !lineStart || lineStart < 1) return
    const lines = editor.getText().split('\n')
    const first = Math.min(lineStart, lines.length)
    const last = Math.min(
      Number.isInteger(lineEnd) && Number(lineEnd) > 0 ? Number(lineEnd) : first,
      lines.length
    )
    const start = Math.min(first, last) - 1
    const end = Math.max(first, last) - 1
    editor.focus()
    editor.setSelections([
      {
        start: { line: start, character: 0 },
        end: { line: end, character: lines[end].length },
        direction: 'forward',
      },
    ])
    publishSelection()
  }
  const createEditor: EditorFactory<undefined, undefined> = (type, options, key) =>
    new Editor(
      type,
      {
        ...options,
        onAttach: (attached, instance) => {
          setEditor(attached)
          options.onAttach?.(attached, instance)
          attached.focus()
          reveal()
        },
        onChange: event => {
          options.onChange?.(event)
          publishSelection()
        },
        onComplete: event => {
          options.onComplete?.(event)
          if (editor !== event.editor) return
          setEditor(null)
          publishSelection()
        },
      },
      key
    )
  return {
    createEditor,
    publishSelection,
    bindView(
      view: WorkspaceCodeView,
      container: HTMLElement | null,
      lineStart?: number,
      lineEnd?: number
    ) {
      host = container
      const next = { view }
      binding = next
      const changed =
        !lineTarget || lineTarget.lineStart !== lineStart || lineTarget.lineEnd !== lineEnd
      lineTarget = { lineStart, lineEnd }
      setEditor(editor)
      if (changed) reveal()
      publishSelection()
      return () => {
        if (binding !== next) return
        binding = null
        host = null
        // Ref metadata changes do not destroy the attached editor or its undo stack.
        content?.removeAttribute('data-testid')
        content = null
        publishSelectedTextSelection(source, null)
      }
    },
    onDragStart(event: React.DragEvent) {
      const text = binding && editor ? selectedEditorText(editor) : null
      if (text) writeSelectedTextDragData(event.dataTransfer, text)
    },
  }
}
