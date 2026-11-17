import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { expect, test, vi } from 'vitest'
import { ComposerTextInput } from '../../../../packages/collaboration/src/composer/ComposerTextInput'

test('Enter waits for a clipboard transfer even when the editor already contains text', async () => {
  let finish!: (value: { referenceEntries: []; attachmentFiles: [] }) => void
  const resolveTransfer = vi.fn(
    () =>
      new Promise<{ referenceEntries: []; attachmentFiles: [] }>(resolve => {
        finish = resolve
      })
  )
  const send = vi.fn()
  const ready = vi.fn()
  render(
    <ComposerTextInput
      value="Preserved answer"
      onChange={vi.fn()}
      onSubmit={send}
      canSend
      placeholder="Reply"
      testId="transfer-editor"
      rows={1}
      textareaRef={createRef()}
      className=""
      onTransferReadyChange={ready}
      transferServices={{ hasPathTransfer: () => true, resolveTransfer }}
    />
  )
  const editor = screen.getByTestId('transfer-editor')
  fireEvent.paste(editor, { clipboardData: { files: [], types: ['Files'], getData: () => '' } })
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(false))
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(send).not.toHaveBeenCalled()
  await act(async () => finish({ referenceEntries: [], attachmentFiles: [] }))
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true))
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(send).toHaveBeenCalledWith('Preserved answer', undefined)
})
