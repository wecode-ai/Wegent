import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { Compartment, EditorState } from '@codemirror/state'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { publishSelectedTextSelection, writeSelectedTextDragData } from '@/lib/selected-text-drag'

interface WorkspaceTextFileEditorProps {
  path: string
  value: string
  themeType: 'light' | 'dark'
  targetLineStart?: number
  targetLineEnd?: number
  onChange: (value: string) => void
  onSave: () => void
}

const syntaxTheme = HighlightStyle.define([
  { tag: tags.keyword, color: 'rgb(var(--color-syntax-keyword))' },
  { tag: [tags.string, tags.regexp], color: 'rgb(var(--color-syntax-string))' },
  { tag: [tags.number, tags.bool, tags.null], color: 'rgb(var(--color-syntax-number))' },
  { tag: tags.variableName, color: 'rgb(var(--color-syntax-variable))' },
  { tag: tags.function(tags.variableName), color: 'rgb(var(--color-syntax-function))' },
  { tag: [tags.typeName, tags.className], color: 'rgb(var(--color-syntax-type))' },
  { tag: tags.comment, color: 'rgb(var(--color-syntax-comment))' },
  { tag: tags.operator, color: 'rgb(var(--color-syntax-operator))' },
  { tag: tags.punctuation, color: 'rgb(var(--color-syntax-punctuation))' },
  { tag: tags.tagName, color: 'rgb(var(--color-syntax-keyword))' },
  { tag: tags.attributeName, color: 'rgb(var(--color-syntax-variable))' },
])

function languageForPath(path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  if (['js', 'jsx', 'mjs', 'ts', 'tsx'].includes(extension ?? '')) {
    return javascript({ jsx: extension?.includes('x'), typescript: extension?.startsWith('t') })
  }
  if (extension === 'json') return json()
  if (extension === 'css') return css()
  if (['html', 'htm', 'svg', 'xml'].includes(extension ?? '')) return html()
  if (['md', 'markdown'].includes(extension ?? '')) return markdown()
  if (extension === 'py') return python()
  if (extension === 'rs') return rust()
  return []
}

function editorTheme(themeType: 'light' | 'dark') {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: 'var(--text-code)',
        color: 'rgb(var(--color-text-primary))',
        backgroundColor: 'rgb(var(--color-bg-base))',
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'var(--font-code)',
      },
      '.cm-content, .cm-line': {
        caretColor: 'rgb(var(--color-text-primary))',
      },
      '.cm-gutters': {
        backgroundColor: 'rgb(var(--color-bg-surface))',
        borderRight: '1px solid rgb(var(--color-border))',
        color: 'rgb(var(--color-text-muted))',
      },
      '.cm-activeLine, .cm-activeLineGutter': {
        backgroundColor: 'rgb(var(--color-muted))',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgb(var(--color-primary) / 0.24) !important',
      },
      '.cm-searchMatch, .cm-selectionMatch': {
        backgroundColor: 'rgb(var(--color-warning) / 0.2)',
        outline: '1px solid rgb(var(--color-warning) / 0.4)',
      },
      '.cm-searchMatch-selected': {
        backgroundColor: 'rgb(var(--color-primary) / 0.25)',
        outline: '1px solid rgb(var(--color-primary))',
      },
      '.cm-matchingBracket': {
        backgroundColor: 'rgb(var(--color-primary) / 0.2)',
        outline: '1px solid rgb(var(--color-primary) / 0.4)',
      },
      '.cm-panels, .cm-tooltip': {
        backgroundColor: 'rgb(var(--color-popover))',
        color: 'rgb(var(--color-text-primary))',
        border: '1px solid rgb(var(--color-border))',
      },
      '.cm-textfield, .cm-button': {
        background: 'rgb(var(--color-bg-surface))',
        color: 'rgb(var(--color-text-primary))',
        border: '1px solid rgb(var(--color-border))',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'rgb(var(--color-primary))',
        color: 'rgb(var(--color-primary-contrast))',
      },
      '&.cm-focused': { outline: 'none' },
    },
    { dark: themeType === 'dark' }
  )
}

function editorSelectionRect(
  editorView: EditorView,
  from: number,
  to: number
): { left: number; top: number; width: number; height: number } | null {
  const start = editorView.coordsAtPos(from)
  const end = editorView.coordsAtPos(to)
  if (!start || !end) return null

  const left = Math.min(start.left, end.left)
  const top = Math.min(start.top, end.top)
  const right = Math.max(start.right, end.right)
  const bottom = Math.max(start.bottom, end.bottom)
  return { left, top, width: right - left, height: bottom - top }
}

export function WorkspaceTextFileEditor({
  path,
  value,
  themeType,
  targetLineStart,
  targetLineEnd,
  onChange,
  onSave,
}: WorkspaceTextFileEditorProps) {
  const selectionSource = `workspace-editor:${path}`
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartmentRef = useRef(new Compartment())
  const initialValueRef = useRef(value)
  const initialThemeRef = useRef(themeType)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)

  useEffect(() => {
    onChangeRef.current = onChange
    onSaveRef.current = onSave
  }, [onChange, onSave])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const saveKeymap = {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSaveRef.current()
        return true
      },
    }
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          bracketMatching(),
          syntaxHighlighting(syntaxTheme),
          languageForPath(path),
          keymap.of([
            saveKeymap,
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
            if (update.selectionSet || update.docChanged) {
              const selection = update.state.selection.main
              publishSelectedTextSelection(
                selectionSource,
                selection.empty ? null : update.state.sliceDoc(selection.from, selection.to),
                selection.empty
                  ? null
                  : editorSelectionRect(update.view, selection.from, selection.to)
              )
            }
          }),
          EditorView.domEventHandlers({
            dragstart(event, editorView) {
              const selection = editorView.state.selection.main
              if (!event.dataTransfer || selection.empty) return false
              writeSelectedTextDragData(
                event.dataTransfer,
                editorView.state.sliceDoc(selection.from, selection.to)
              )
              return false
            },
          }),
          themeCompartmentRef.current.of(editorTheme(initialThemeRef.current)),
        ],
      }),
    })
    viewRef.current = view
    view.focus()
    return () => {
      publishSelectedTextSelection(selectionSource, null)
      viewRef.current = null
      view.destroy()
    }
  }, [path, selectionSource])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartmentRef.current.reconfigure(editorTheme(themeType)),
    })
  }, [themeType])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !Number.isInteger(targetLineStart) || Number(targetLineStart) < 1) return

    const startLineNumber = Math.min(Number(targetLineStart), view.state.doc.lines)
    const endLineNumber = Math.min(
      Math.max(Number.isInteger(targetLineEnd) ? Number(targetLineEnd) : startLineNumber, 1),
      view.state.doc.lines
    )
    const startLine = view.state.doc.line(Math.min(startLineNumber, endLineNumber))
    const endLine = view.state.doc.line(Math.max(startLineNumber, endLineNumber))
    view.dispatch({
      selection: { anchor: startLine.from, head: endLine.to },
      effects: EditorView.scrollIntoView(startLine.from, { y: 'center' }),
    })
    view.focus()
  }, [path, targetLineEnd, targetLineStart])

  return (
    <div
      ref={hostRef}
      data-testid="workspace-file-editor"
      data-theme={themeType}
      className="min-h-0 flex-1 bg-background"
    />
  )
}
