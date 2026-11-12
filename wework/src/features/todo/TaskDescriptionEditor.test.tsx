import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { detectInitialImeCodeBlockDuplicate, detectInitialImeDuplicate } from './imeComposition'
import { normalizeTaskDescription } from './taskDescription'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'

describe('TaskDescriptionEditor', () => {
  it('repairs only the WebKit first-composition duplicate shape', () => {
    const original = {
      id: 'nested-empty-block',
      type: 'bulletListItem',
      props: {},
      content: [{ type: 'text', text: "dan'shi", styles: {} }],
      children: [],
    }
    const committed = {
      id: 'webkit-created-block',
      type: 'bulletListItem',
      props: {},
      content: [{ type: 'text', text: '但是', styles: {} }],
      children: [],
    }
    const snapshot = {
      blockId: original.id,
      nextBlockId: 'previous-next-block',
      parentBlockId: 'parent-list-item',
    }

    expect(
      detectInitialImeDuplicate(snapshot, original, committed, 'parent-list-item', '但是')
    ).toEqual({
      targetBlockId: original.id,
      duplicateBlockId: committed.id,
      content: committed.content,
    })
    expect(
      detectInitialImeDuplicate(snapshot, original, committed, 'different-parent', '但是')
    ).toBeNull()
    expect(
      detectInitialImeDuplicate(
        { ...snapshot, nextBlockId: committed.id },
        original,
        committed,
        'parent-list-item',
        '但是'
      )
    ).toBeNull()
  })

  it('repairs an initial IME duplicate inside a single empty code block', () => {
    const codeBlock = {
      id: 'empty-code-block',
      type: 'codeBlock',
      props: { language: 'text' },
      content: [{ type: 'text', text: "ce'shi\n测试下", styles: {} }],
      children: [],
    }
    const snapshot = {
      blockId: codeBlock.id,
      nextBlockId: 'following-block',
    }
    const followingBlock = {
      id: 'following-block',
      type: 'paragraph',
      props: {},
      content: [],
      children: [],
    }

    expect(
      detectInitialImeCodeBlockDuplicate(snapshot, codeBlock, followingBlock, '测试下')
    ).toEqual({
      targetBlockId: codeBlock.id,
      content: '测试下',
    })
    expect(
      detectInitialImeCodeBlockDuplicate(
        snapshot,
        { ...codeBlock, content: [{ type: 'text', text: '正常代码\n测试下', styles: {} }] },
        followingBlock,
        '测试下'
      )
    ).toBeNull()
    expect(
      detectInitialImeCodeBlockDuplicate(
        snapshot,
        codeBlock,
        { ...followingBlock, id: 'unexpected-new-block' },
        '测试下'
      )
    ).toBeNull()
  })

  it('treats legacy empty HTML as an empty description', async () => {
    const onChange = vi.fn()
    render(<TaskDescriptionEditor value="<p></p>" onChange={onChange} />)

    const editor = await screen.findByTestId('cloud-todo-detail-description')
    expect(normalizeTaskDescription('<p></p>')).toBe('')
    expect(normalizeTaskDescription('&lt;p&gt;&lt;br&gt;&lt;/p&gt;')).toBe('')
    expect(editor.textContent).not.toContain('<p></p>')
    // Opening an item never rewrites its stored description.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not publish intermediate pinyin while an IME composition is active', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<TaskDescriptionEditor value="" onChange={onChange} />)
    const editor = await screen.findByTestId('cloud-todo-detail-description')
    const downstreamKeydown = vi.fn()
    editor.addEventListener('keydown', downstreamKeydown)

    fireEvent.compositionStart(editor)
    await user.click(editor)
    await user.keyboard("dan'shi")
    fireEvent.keyDown(editor, {
      key: ' ',
      code: 'Space',
      keyCode: 32,
      isComposing: true,
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(downstreamKeydown).toHaveBeenCalled()

    fireEvent.compositionEnd(editor)
    await waitFor(() => expect(onChange).toHaveBeenCalled())
  })
})
