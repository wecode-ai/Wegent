// @vitest-environment jsdom
import { expect, test } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { composerSchema } from '@wegent/collaboration/composer/composerProseMirrorModel'
import {
  composerMarkdownInputRules,
  convertTypedComposerTable,
} from '../../../../../packages/collaboration/src/composer/composerMarkdownInputRules'

function editor(paragraphs: string[]) {
  const doc = composerSchema.node(
    'doc',
    null,
    paragraphs.map(text =>
      composerSchema.node('paragraph', null, text ? composerSchema.text(text) : null)
    )
  )
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({
      doc,
      selection: TextSelection.atEnd(doc),
      plugins: [composerMarkdownInputRules()],
    }),
  })
  return view
}

test.each([
  ['-', 'bullet_list'],
  ['7.', 'ordered_list'],
  ['##', 'heading'],
  ['>', 'blockquote'],
  ['```js', 'code_block'],
])('converts a typed %s prefix', (prefix, type) => {
  const view = editor([prefix])
  try {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', handler =>
      handler(view, from, to, ' ', () => view.state.tr.insertText(' '))
    )
    expect(handled).toBe(true)
    expect(view.state.doc.firstChild?.type.name).toBe(type)
    if (type === 'ordered_list') expect(view.state.doc.firstChild?.attrs.start).toBe(7)
  } finally {
    view.destroy()
  }
})

test('turns a typed table header, separator and data row into a table before submission', () => {
  const view = editor(['| test-a | test-b |', '| --- | --- |', '| one | two |'])
  try {
    expect(convertTypedComposerTable(view)).toBe(true)
    expect(view.state.doc.firstChild?.type.name).toBe('table')
    expect(view.state.doc.firstChild?.textContent).toBe('test-atest-bonetwo')
  } finally {
    view.destroy()
  }
})
