import '@testing-library/jest-dom'
import { render, waitFor } from '@testing-library/react'

import { QueueMessageHandler } from '@/features/inbox/components/QueueMessageHandler'

const replace = jest.fn()
const mockUseSearchParams = jest.fn()
const getQueueMessage = jest.fn()
const updateMessageStatus = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => mockUseSearchParams(),
  usePathname: () => '/code',
}))

jest.mock('@/apis/work-queue', () => ({
  getQueueMessage: (...args: unknown[]) => getQueueMessage(...args),
  updateMessageStatus: (...args: unknown[]) => updateMessageStatus(...args),
}))

describe('QueueMessageHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('clears process_message while staying on the current pathname', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('process_message=5'))
    getQueueMessage.mockResolvedValue({
      id: 5,
      note: null,
      sourceTaskId: 10,
      sender: { userName: 'alice' },
      contentSnapshot: [{ role: 'USER', content: 'hello' }],
    })
    updateMessageStatus.mockResolvedValue(undefined)

    render(<QueueMessageHandler onQueueMessageLoaded={jest.fn()} />)

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/code')
    })
  })
})
