import { Editor, type EditorFactory, type EditorType } from '@pierre/diffs/edit'
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { publishSelectedTextSelection, writeSelectedTextDragData } from '@/lib/selected-text-drag'

type WorkspaceEditor = Editor<EditorType, undefined, undefined>

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

export function useWorkspaceCodeEditor(
  path: string,
  hostRef: RefObject<HTMLElement | null>,
  lineStart?: number,
  lineEnd?: number
) {
  const editorRef = useRef<WorkspaceEditor | null>(null)
  const contentRef = useRef<HTMLElement | null>(null)
  const lineTarget = useRef({ lineStart, lineEnd })
  useLayoutEffect(() => {
    lineTarget.current = { lineStart, lineEnd }
  }, [lineStart, lineEnd])
  const source = `workspace-editor:${path}`
  const publishSelection = useCallback(() => {
    const editor = editorRef.current
    const nativeSelection = window.getSelection()
    const rect = nativeSelection?.rangeCount
      ? nativeSelection.getRangeAt(0).getBoundingClientRect()
      : null
    publishSelectedTextSelection(source, editor ? selectedEditorText(editor) : null, rect)
  }, [source])

  const reveal = useCallback(
    (editor: WorkspaceEditor) => {
      const { lineStart, lineEnd } = lineTarget.current
      if (!Number.isInteger(lineStart) || !lineStart || lineStart < 1) return
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
    },
    [publishSelection]
  )

  const createEditor = useCallback<EditorFactory<undefined, undefined>>(
    (type, options, key) =>
      new Editor(
        type,
        {
          ...options,
          onAttach: (editor, instance) => {
            editorRef.current = editor
            const content = hostRef.current
              ?.querySelector('diffs-container')
              ?.shadowRoot?.querySelector<HTMLElement>('[data-content][role="textbox"]')
            if (content) content.dataset.testid = 'workspace-file-editor-content'
            contentRef.current = content ?? null
            options.onAttach?.(editor, instance)
            editor.focus()
            reveal(editor)
          },
          onChange: event => {
            options.onChange?.(event)
            publishSelection()
          },
          onComplete: event => {
            options.onComplete?.(event)
            if (editorRef.current === event.editor) {
              editorRef.current = null
              contentRef.current?.removeAttribute('data-testid')
              contentRef.current = null
            }
            publishSelectedTextSelection(source, null)
          },
        },
        key
      ),
    [hostRef, publishSelection, reveal, source]
  )

  useEffect(() => {
    if (editorRef.current) reveal(editorRef.current)
  }, [lineStart, lineEnd, reveal])

  useEffect(() => {
    const onSelectionChange = () => {
      if (hostRef.current?.contains(document.activeElement)) publishSelection()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      publishSelectedTextSelection(source, null)
    }
  }, [hostRef, publishSelection, source])

  return {
    createEditor,
    publishSelection,
    onDragStart: (event: React.DragEvent) => {
      const text = editorRef.current ? selectedEditorText(editorRef.current) : null
      if (text) writeSelectedTextDragData(event.dataTransfer, text)
    },
  }
}
