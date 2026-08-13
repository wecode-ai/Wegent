import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TaskDescriptionEditor } from './TaskDescriptionEditor'
import { normalizeTaskDescription } from './taskDescription'

describe('TaskDescriptionEditor', () => {
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
    const onPasteFiles = vi.fn()
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

  it('applies external Markdown updates in place', async () => {
    const view = render(<TaskDescriptionEditor value={'旧内容'} onChange={vi.fn()} />)
    const editor = await screen.findByTestId('cloud-todo-detail-description')

    view.rerender(<TaskDescriptionEditor value={'新内容'} onChange={vi.fn()} />)

    expect(editor.textContent).toContain('新内容')
  })

  describe('attachment image preview', () => {
    beforeAll(() => {
      if (typeof URL.createObjectURL !== 'function') {
        URL.createObjectURL = () => 'blob:mock-attachment'
      }
      URL.revokeObjectURL = vi.fn()
    })

    it('fetches attachment images only when hovered', async () => {
      const readAttachment = vi.fn(async () => new Blob(['fake-image'], { type: 'image/png' }))
      render(
        <TaskDescriptionEditor
          value={'[image.png](wegent://attachments/att-1)'}
          onChange={vi.fn()}
          readAttachment={readAttachment}
        />
      )
      const editor = await screen.findByTestId('cloud-todo-detail-description')
      expect(readAttachment).not.toHaveBeenCalled()

      const link = editor.querySelector('a[href="wegent://attachments/att-1"]') as HTMLAnchorElement
      expect(link).toBeTruthy()
      fireEvent.mouseOver(link)

      await waitFor(() => expect(readAttachment).toHaveBeenCalledWith('att-1'))
      const preview = await screen.findByAltText('image.png')
      expect(preview.getAttribute('src')).toMatch(/^blob:/)
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

    it('opens a zoomable lightbox from the hover preview', async () => {
      const readAttachment = vi.fn(async () => new Blob(['fake-image'], { type: 'image/png' }))
      render(
        <TaskDescriptionEditor
          value={'[image.png](wegent://attachments/att-1)'}
          onChange={vi.fn()}
          readAttachment={readAttachment}
        />
      )
      const editor = await screen.findByTestId('cloud-todo-detail-description')
      const link = editor.querySelector('a[href="wegent://attachments/att-1"]') as HTMLAnchorElement
      fireEvent.mouseOver(link)
      const preview = await screen.findByAltText('image.png')
      const viewButton = screen.getByTestId('cloud-todo-preview-view')
      expect(viewButton).toHaveTextContent('查看大图')
      fireEvent.click(viewButton)

      const lightbox = await screen.findByTestId('cloud-todo-preview-lightbox')
      expect(lightbox.querySelector('img')).toHaveAttribute('src', preview.getAttribute('src'))
      expect(screen.getByText('100%')).toBeTruthy()

      fireEvent.click(screen.getByTestId('cloud-todo-preview-zoom-in'))
      expect(screen.getByText('125%')).toBeTruthy()
      fireEvent.click(screen.getByTestId('cloud-todo-preview-zoom-out'))
      expect(screen.getByText('100%')).toBeTruthy()

      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByTestId('cloud-todo-preview-lightbox')).toBeNull())
    })

    it('keeps the preview open when the mouse moves onto it', async () => {
      const readAttachment = vi.fn(async () => new Blob(['fake-image'], { type: 'image/png' }))
      render(
        <TaskDescriptionEditor
          value={'[image.png](wegent://attachments/att-1)'}
          onChange={vi.fn()}
          readAttachment={readAttachment}
        />
      )
      const editor = await screen.findByTestId('cloud-todo-detail-description')
      const link = editor.querySelector('a[href="wegent://attachments/att-1"]') as HTMLAnchorElement
      fireEvent.mouseOver(link)
      const preview = await screen.findByTestId('cloud-todo-preview')

      // Crossing the gap starts the hide timer; entering the preview must
      // cancel it so the image does not vanish under the cursor.
      fireEvent.mouseOut(link, { relatedTarget: editor })
      fireEvent.mouseOver(preview)
      await new Promise(resolve => setTimeout(resolve, 450))
      expect(screen.getByTestId('cloud-todo-preview')).toBeInTheDocument()
    })

    it('hides the preview immediately when leaving the editor', async () => {
      const readAttachment = vi.fn(async () => new Blob(['fake-image'], { type: 'image/png' }))
      render(
        <TaskDescriptionEditor
          value={'[image.png](wegent://attachments/att-1)'}
          onChange={vi.fn()}
          readAttachment={readAttachment}
        />
      )
      const editor = await screen.findByTestId('cloud-todo-detail-description')
      const link = editor.querySelector('a[href="wegent://attachments/att-1"]') as HTMLAnchorElement
      fireEvent.mouseOver(link)
      await screen.findByTestId('cloud-todo-preview')

      fireEvent.mouseOut(link, { relatedTarget: document.body })
      await waitFor(() => expect(screen.queryByTestId('cloud-todo-preview')).toBeNull())
    })
  })
})
