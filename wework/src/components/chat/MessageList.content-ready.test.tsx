import { render } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { MessageList, type MessageListProps } from '@wegent/collaboration/conversation'

test('commits the updated content readiness callback when only its identity changes', () => {
  const initialReady = vi.fn()
  const nextReady = vi.fn()
  const props: MessageListProps = {
    messages: [],
    userMessageServices: {
      images: { identity: image => String(image.id), load: vi.fn(), download: vi.fn() },
    },
  }
  const { rerender } = render(<MessageList {...props} onContentReady={initialReady} />)
  expect(initialReady).toHaveBeenCalledOnce()
  rerender(<MessageList {...props} onContentReady={nextReady} />)
  expect(nextReady).toHaveBeenCalledOnce()
  expect(initialReady).toHaveBeenCalledOnce()
})
