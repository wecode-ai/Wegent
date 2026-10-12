import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { detectInitialImeCodeBlockDuplicate, detectInitialImeDuplicate } from './imeComposition'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'
import { normalizeTaskDescription } from './taskDescription'

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

  it('loads Markdown blocks and emits Markdown on edit', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<TaskDescriptionEditor value={'# 标题\n\n**加粗** and *斜体*'} onChange={onChange} />)

    const editor = await screen.findByTestId('cloud-todo-detail-description')
    expect(editor.querySelector('h1')).toHaveTextContent('标题')
    expect(editor.querySelector('strong')).toHaveTextContent('加粗')

    await user.click(editor)
    await user.keyboard('正文')
    expect(onChange).toHaveBeenCalled()
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('正文')
  })

  it('routes pasted files to the shared attachment flow', async () => {
    const onPasteFiles = vi.fn(async () => null)
    render(<TaskDescriptionEditor value="" onChange={vi.fn()} onPasteFiles={onPasteFiles} />)
    const editor = await screen.findByTestId('cloud-todo-detail-description')
    const file = new File(['image'], 'capture.png', { type: 'image/png' })

    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { files: [file], types: ['Files'] },
    })
    editor.dispatchEvent(paste)

    expect(onPasteFiles).toHaveBeenCalledWith([file])
  })

  it('inserts uploaded attachment Markdown next to the paste position', async () => {
    const onChange = vi.fn()
    const onPasteFiles = vi.fn(
      async () =>
        '[capture.png](wegent://attachments/attachment-pasted)\n<!-- wegent-attachment:attachment-pasted -->'
    )
    render(
      <TaskDescriptionEditor
        value="前文"
        onChange={onChange}
        onPasteFiles={onPasteFiles}
        readAttachment={vi.fn(async () => new Blob(['image'], { type: 'image/png' }))}
      />
    )
    const editor = await screen.findByTestId('cloud-todo-detail-description')
    const file = new File(['image'], 'capture.png', { type: 'image/png' })
    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { files: [file], types: ['Files'] },
    })

    editor.dispatchEvent(paste)

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.stringContaining('wegent://attachments/attachment-pasted')
      )
    )
    expect(
      await screen.findByTestId('task-description-attachment-image-attachment-pasted')
    ).toBeInTheDocument()
  })

  it('applies external Markdown updates in place', async () => {
    const view = render(<TaskDescriptionEditor value={'旧内容'} onChange={vi.fn()} />)
    const editor = await screen.findByTestId('cloud-todo-detail-description')

    view.rerender(<TaskDescriptionEditor value={'新内容'} onChange={vi.fn()} />)

    expect(editor.textContent).toContain('新内容')
  })

  it('renders attachment image blocks after an external Markdown update', async () => {
    const readAttachment = vi.fn(async () => new Blob(['image'], { type: 'image/png' }))
    const onInlineAttachmentIdsChange = vi.fn()
    const view = render(
      <TaskDescriptionEditor
        value=""
        onChange={vi.fn()}
        readAttachment={readAttachment}
        onInlineAttachmentIdsChange={onInlineAttachmentIdsChange}
      />
    )
    await screen.findByTestId('cloud-todo-detail-description')

    view.rerender(
      <TaskDescriptionEditor
        value="[late.png](wegent://attachments/late-image)"
        onChange={vi.fn()}
        readAttachment={readAttachment}
        onInlineAttachmentIdsChange={onInlineAttachmentIdsChange}
      />
    )

    expect(
      await screen.findByTestId('task-description-attachment-image-late-image')
    ).toBeInTheDocument()
    expect((await screen.findByAltText('late.png')).getAttribute('src')).toMatch(/^blob:/)
    expect(onInlineAttachmentIdsChange).toHaveBeenCalledWith(['late-image'])
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

  it('allows the first ordinary Enter immediately after compositionend', async () => {
    render(<TaskDescriptionEditor value="但是" onChange={vi.fn()} />)
    const editor = await screen.findByTestId('cloud-todo-detail-description')
    const downstreamKeydown = vi.fn()
    editor.addEventListener('keydown', downstreamKeydown)

    fireEvent.compositionStart(editor)
    fireEvent.compositionEnd(editor)
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 13 })
    expect(downstreamKeydown).toHaveBeenCalledOnce()
  })

  describe('attachment image preview', () => {
    beforeAll(() => {
      if (typeof URL.createObjectURL !== 'function') {
        URL.createObjectURL = () => 'blob:mock-attachment'
      }
      URL.revokeObjectURL = vi.fn()
    })

    it('renders attachment images inline without waiting for hover', async () => {
      const readAttachment = vi.fn(async () => new Blob(['fake-image'], { type: 'image/png' }))
      const onInlineAttachmentIdsChange = vi.fn()
      render(
        <TaskDescriptionEditor
          value={'[image.png](wegent://attachments/att-1)'}
          onChange={vi.fn()}
          readAttachment={readAttachment}
          onInlineAttachmentIdsChange={onInlineAttachmentIdsChange}
        />
      )
      await screen.findByTestId('cloud-todo-detail-description')
      await waitFor(() => expect(readAttachment).toHaveBeenCalledWith('att-1'))
      const image = await screen.findByAltText('image.png')
      expect(image.getAttribute('src')).toMatch(/^blob:/)
      expect(onInlineAttachmentIdsChange).toHaveBeenCalledWith(['att-1'])

      fireEvent.click(screen.getByRole('button', { name: '预览 image.png' }))
      expect(screen.getByRole('dialog', { name: '预览 image.png' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))
      expect(screen.queryByRole('dialog', { name: '预览 image.png' })).toBeNull()
    })

    it('does not fetch non-image attachments', async () => {
      const readAttachment = vi.fn(async () => new Blob(['fake-pdf'], { type: 'application/pdf' }))
      render(
        <TaskDescriptionEditor
          value={'[report.pdf](wegent://attachments/att-2)'}
          onChange={vi.fn()}
          readAttachment={readAttachment}
        />
      )
      const editor = await screen.findByTestId('cloud-todo-detail-description')
      const link = editor.querySelector('a[href="wegent://attachments/att-2"]') as HTMLAnchorElement
      fireEvent.mouseOver(link)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(readAttachment).not.toHaveBeenCalled()
    })
  })
})
