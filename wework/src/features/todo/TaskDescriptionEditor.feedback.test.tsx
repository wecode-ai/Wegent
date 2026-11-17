import { act, render } from '@testing-library/react'
import { useLayoutEffect, useState } from 'react'
import { expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ editor: {} as Record<string, unknown>, change: () => {} }))
vi.mock('@blocknote/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@blocknote/react')>()),
  useCreateBlockNote: () => fixture.editor,
}))
vi.mock('@blocknote/mantine', () => ({
  BlockNoteView: ({ onChange }: { onChange: () => void }) => {
    fixture.change = onChange
    return null
  },
}))
import { TaskDescriptionEditor } from './TaskDescriptionEditor'

const paragraph = (text: string) => ({
  id: text || 'empty',
  type: 'paragraph',
  props: {},
  content: text ? [{ type: 'text', text, styles: {} }] : [],
  children: [],
})

test('a parent echo cannot replace a newer native edit before passive effects run', () => {
  const editor = {
    document: [paragraph('seed')],
    domElement: document.createElement('div'),
    tryParseMarkdownToBlocks: (value: string) => [paragraph(value)],
    blocksToMarkdownLossy: (blocks: ReturnType<typeof paragraph>[]) =>
      blocks.flatMap(block => block.content.map(item => item.text)).join('\n\n'),
    replaceBlocks: vi.fn((_previous, next) => {
      editor.document = next
    }),
  }
  fixture.editor = editor
  let reset!: (value: string) => void
  function Owner() {
    const [value, setValue] = useState('seed')
    reset = setValue
    useLayoutEffect(() => {
      if (value !== 'first') return
      // Native editor transactions can arrive between commit and passive effects.
      editor.document = [paragraph('second'), paragraph('')]
      fixture.change()
    }, [value])
    return <TaskDescriptionEditor value={value} onChange={setValue} />
  }
  render(<Owner />)
  expect(editor.replaceBlocks).toHaveBeenCalledTimes(1)
  act(() => {
    editor.document = [paragraph('first'), paragraph('')]
    fixture.change()
  })
  expect(editor.document).toEqual([paragraph('second'), paragraph('')])
  expect(editor.replaceBlocks).toHaveBeenCalledTimes(1)
  act(() => reset('external replacement'))
  expect(editor.document).toEqual([paragraph('external replacement')])
  expect(editor.replaceBlocks).toHaveBeenCalledTimes(2)
  act(() => reset('second'))
  expect(editor.document).toEqual([paragraph('second')])
  expect(editor.replaceBlocks).toHaveBeenCalledTimes(3)
})
