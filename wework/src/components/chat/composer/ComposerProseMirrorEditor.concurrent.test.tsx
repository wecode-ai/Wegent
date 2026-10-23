import { act, fireEvent, render, screen } from '@testing-library/react'
import { Suspense, createRef, startTransition, useState } from 'react'
import { expect, test, vi } from 'vitest'
import { ComposerProseMirrorEditor } from './ComposerProseMirrorEditor'

test('keeps native keyboard callbacks from the committed render during a suspended update', async () => {
  const onCommittedKeyDown = vi.fn(() => true)
  const onPendingKeyDown = vi.fn(() => true)
  const pending = new Promise<void>(() => undefined)
  let suspendUpdate: () => void = () => undefined
  function Suspend({ active }: { active: boolean }) {
    if (active) throw pending
    return null
  }
  function Harness() {
    const [suspended, setSuspended] = useState(false)
    suspendUpdate = () => startTransition(() => setSuspended(true))
    return (
      <Suspense fallback={<div>Loading</div>}>
        <ComposerProseMirrorEditor
          value="Send this message"
          onChange={vi.fn()}
          onSnapshotChange={vi.fn()}
          onKeyDown={suspended ? onPendingKeyDown : onCommittedKeyDown}
          onBeforeInput={() => false}
          onKeyUp={vi.fn()}
          onCompositionStart={vi.fn()}
          onCompositionEnd={vi.fn()}
          onPaste={() => false}
          onDrop={() => false}
          onClick={vi.fn()}
          onFocus={vi.fn()}
          testId="committed-editor"
          rows={2}
          textareaRef={createRef<HTMLElement>()}
        />
        <Suspend active={suspended} />
      </Suspense>
    )
  }
  render(<Harness />)
  await act(async () => suspendUpdate())

  fireEvent.keyDown(screen.getByTestId('committed-editor'), { key: 'Enter' })

  expect(onCommittedKeyDown).toHaveBeenCalledOnce()
  expect(onPendingKeyDown).not.toHaveBeenCalled()
})
