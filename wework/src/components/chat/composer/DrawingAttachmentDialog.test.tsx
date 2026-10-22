import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { DrawingAttachmentDialog } from './DrawingAttachmentDialog'

const drawing = vi.hoisted(() => ({ exportImage: vi.fn() }))

vi.mock('./DrawingCanvas', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    DrawingCanvas: forwardRef(function Canvas(
      { onContentChange }: { onContentChange: (hasContent: boolean) => void },
      ref
    ) {
      useImperativeHandle(ref, () => ({ exportImage: drawing.exportImage }))
      return (
        <>
          <button data-testid="test-draw" onClick={() => onContentChange(true)}>
            Draw
          </button>
          <button data-testid="test-clear" onClick={() => onContentChange(false)}>
            Clear
          </button>
        </>
      )
    }),
  }
})

describe('DrawingAttachmentDialog', () => {
  beforeEach(() => {
    drawing.exportImage.mockReset()
    drawing.exportImage.mockResolvedValue(new File(['png'], 'drawing.png', { type: 'image/png' }))
  })

  it('blocks empty drawings and drawings cleared by undo or deletion', async () => {
    render(<DrawingAttachmentDialog onAttach={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('drawing-confirm-button')).toBeDisabled()
    fireEvent.click(await screen.findByTestId('test-draw'))
    expect(screen.getByTestId('drawing-confirm-button')).toBeEnabled()
    fireEvent.click(screen.getByTestId('test-clear'))
    expect(screen.getByTestId('drawing-confirm-button')).toBeDisabled()
  })

  it('exports and attaches once, then closes', async () => {
    const onAttach = vi.fn()
    const onClose = vi.fn()
    render(<DrawingAttachmentDialog onAttach={onAttach} onClose={onClose} />)
    fireEvent.click(await screen.findByTestId('test-draw'))
    fireEvent.click(screen.getByTestId('drawing-confirm-button'))
    fireEvent.click(screen.getByTestId('drawing-confirm-button'))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(drawing.exportImage).toHaveBeenCalledOnce()
    expect(onAttach).toHaveBeenCalledExactlyOnceWith(expect.any(File))
    expect(onAttach.mock.calls[0][0].type).toBe('image/png')
  })

  it('preserves the canvas after a failed export and allows retry', async () => {
    drawing.exportImage.mockRejectedValueOnce(new Error('Canvas export failed'))
    const onAttach = vi.fn()
    const onClose = vi.fn()
    render(<DrawingAttachmentDialog onAttach={onAttach} onClose={onClose} />)
    fireEvent.click(await screen.findByTestId('test-draw'))
    fireEvent.click(screen.getByTestId('drawing-confirm-button'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(onAttach).not.toHaveBeenCalled()
    expect(screen.getByTestId('test-draw')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('drawing-confirm-button'))
    await waitFor(() => expect(onAttach).toHaveBeenCalledOnce())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps the drawing open while attachment processing is pending', async () => {
    let finish!: () => void
    const onAttach = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const onClose = vi.fn()
    render(<DrawingAttachmentDialog onAttach={onAttach} onClose={onClose} />)
    fireEvent.click(await screen.findByTestId('test-draw'))
    fireEvent.click(screen.getByTestId('drawing-confirm-button'))
    await waitFor(() => expect(onAttach).toHaveBeenCalledOnce())
    expect(screen.getByTestId('drawing-cancel-button')).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => finish())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('cancels without exporting and restores focus when unmounted', async () => {
    const onAttach = vi.fn()
    const onClose = vi.fn()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const view = render(<DrawingAttachmentDialog onAttach={onAttach} onClose={onClose} />)
    fireEvent.click(await screen.findByTestId('test-draw'))
    fireEvent.click(screen.getByTestId('drawing-cancel-button'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onAttach).not.toHaveBeenCalled()
    expect(drawing.exportImage).not.toHaveBeenCalled()
    view.unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('closes on Escape and ignores backdrop clicks', () => {
    const onClose = vi.fn()
    render(<DrawingAttachmentDialog onAttach={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('drawing-attachment-dialog').parentElement!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
