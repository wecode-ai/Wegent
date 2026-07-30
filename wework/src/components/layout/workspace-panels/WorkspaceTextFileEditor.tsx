import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
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

interface WorkspaceTextFileEditorProps {
  path: string
  value: string
  onChange: (value: string) => void
  onSave: () => void
}

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

export function WorkspaceTextFileEditor({
  path,
  value,
  onChange,
  onSave,
}: WorkspaceTextFileEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const initialValueRef = useRef(value)
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
          syntaxHighlighting(defaultHighlightStyle),
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
          }),
          EditorView.theme({
            '&': {
              height: '100%',
              fontSize: 'var(--text-code)',
              backgroundColor: 'rgb(255 255 255)',
            },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: 'var(--font-code)',
            },
            '.cm-gutters': {
              backgroundColor: 'rgb(247 247 248)',
              borderRight: '1px solid rgb(224 224 224)',
              color: 'rgb(140 140 140)',
            },
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgb(247 247 248)' },
            '&.cm-focused': { outline: 'none' },
          }),
        ],
      }),
    })
    view.focus()
    return () => view.destroy()
  }, [path])

  return <div ref={hostRef} data-testid="workspace-file-editor" className="min-h-0 flex-1" />
}
