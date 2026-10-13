import { useEffect } from 'react'
import { act, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { EmbeddedLocalTerminal } from './LazyWorkspaceTerminal'

const terminal = vi.hoisted(() => {
  let release: () => void = () => {}
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  return { pending, release }
})
vi.mock('./EmbeddedLocalTerminal', async () => {
  await terminal.pending
  return {
    EmbeddedLocalTerminal: ({ onContentReady }: { onContentReady?: () => void }) => {
      useEffect(() => {
        onContentReady?.()
      }, [onContentReady])
      return <p>Committed Harness terminal</p>
    },
  }
})

test('reports Harness content readiness only after the terminal module renders', async () => {
  const ready = vi.fn(() => expect(screen.getByText('Committed Harness terminal')).toBeVisible())
  render(<EmbeddedLocalTerminal sessionId="cold-harness" active onContentReady={ready} />)
  expect(screen.getByRole('status')).toBeVisible()
  expect(ready).not.toHaveBeenCalled()
  await act(async () => {
    terminal.release()
    await vi.dynamicImportSettled()
  })
  expect(ready).toHaveBeenCalledOnce()
})
