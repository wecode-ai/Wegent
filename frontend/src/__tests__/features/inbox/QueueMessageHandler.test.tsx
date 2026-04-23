import '@testing-library/jest-dom'
import { render, waitFor } from '@testing-library/react'

import { QueueMessageHandler } from '@/features/inbox/components/QueueMessageHandler'

const replace = jest.fn()
const mockUseSearchParams = jest.fn()
const mockUsePathname = jest.fn()
const getQueueMessage = jest.fn()
const updateMessageStatus = jest.fn()
const listSubtasks = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => mockUseSearchParams(),
  usePathname: () => mockUsePathname(),
}))

jest.mock('@/apis/work-queue', () => ({
  getQueueMessage: (...args: unknown[]) => getQueueMessage(...args),
  updateMessageStatus: (...args: unknown[]) => updateMessageStatus(...args),
}))

jest.mock('@/apis/subtasks', () => ({
  subtaskApis: {
    listSubtasks: (...args: unknown[]) => listSubtasks(...args),
  },
}))

describe('QueueMessageHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUsePathname.mockReturnValue('/code')
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

  it('clears forward params while staying on the current pathname', async () => {
    mockUsePathname.mockReturnValue('/task')
    mockUseSearchParams.mockReturnValue(
      new URLSearchParams('forwardTaskId=12&forwardSubtaskIds=3,4')
    )
    listSubtasks.mockResolvedValue({
      items: [
        { id: 3, role: 'USER', prompt: 'first', result: null },
        { id: 4, role: 'ASSISTANT', prompt: '', result: { value: 'second' } },
      ],
    })

    render(<QueueMessageHandler onQueueMessageLoaded={jest.fn()} />)

    await waitFor(() => {
      expect(listSubtasks).toHaveBeenCalledWith({
        taskId: 12,
        limit: 100,
        fromLatest: true,
      })
      expect(replace).toHaveBeenCalledWith('/task')
    })
  })
})
