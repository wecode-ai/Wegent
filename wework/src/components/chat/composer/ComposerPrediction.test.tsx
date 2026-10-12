import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ComposerProseMirrorEditor, type ComposerEditorHandle } from './ComposerProseMirrorEditor'

function setup(value = '') {
  const ref = createRef<ComposerEditorHandle>()
  const onChange = vi.fn()
  const onKeyDown = vi.fn(() => false)
  const onAccept = vi.fn()
  render(
    <ComposerProseMirrorEditor
      ref={ref}
      value={value}
      onChange={onChange}
      prediction={{ text: '请继续，保留所有正在运行的任务。', onAccept }}
      onSnapshotChange={vi.fn()}
      onKeyDown={onKeyDown}
      onBeforeInput={() => false}
      onKeyUp={vi.fn()}
      onCompositionStart={vi.fn()}
      onCompositionEnd={vi.fn()}
      onPaste={() => false}
      onDrop={() => false}
      onOpenMentionPlugin={vi.fn()}
      onOpenMentionFile={vi.fn()}
      onClick={vi.fn()}
      onFocus={vi.fn()}
      placeholder="Message"
      testId="prediction-editor"
      rows={2}
      textareaRef={createRef<HTMLElement>()}
      className="min-h-12"
    />
  )
  return { ref, onChange, onKeyDown, onAccept, editor: screen.getByTestId('prediction-editor') }
}

describe('composer reply prediction', () => {
  it.each(['Enter', 'Tab', 'ArrowRight'])('accepts %s into editable draft without sending', key => {
    const { ref, onChange, onKeyDown, onAccept, editor } = setup()
    expect(screen.getByTestId('prediction-editor-prediction')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
    expect(ref.current!.getSnapshot().value).toBe('')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key })
    expect(ref.current!.getSnapshot().value).toBe('请继续，保留所有正在运行的任务。')
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(screen.queryByTestId('prediction-editor-prediction')).toBeNull()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onKeyDown).toHaveBeenCalled()
    act(() => ref.current!.setValue('我修改后的回复'))
    expect(ref.current!.getSnapshot().value).toBe('我修改后的回复')
  })

  it('preserves an existing draft and modified keyboard commands', () => {
    const { ref, editor, onAccept } = setup('原来的草稿')
    expect(screen.queryByTestId('prediction-editor-prediction')).toBeNull()
    fireEvent.keyDown(editor, { key: 'ArrowRight' })
    expect(ref.current!.getSnapshot().value).toBe('原来的草稿')
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('does not accept during Chinese IME composition or with a modifier', () => {
    const { ref, editor, onAccept } = setup()
    fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true })
    fireEvent.compositionStart(editor)
    expect(screen.queryByTestId('prediction-editor-prediction')).toBeNull()
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(ref.current!.getSnapshot().value).toBe('')
    expect(onAccept).not.toHaveBeenCalled()
    fireEvent.compositionEnd(editor)
  })
})
