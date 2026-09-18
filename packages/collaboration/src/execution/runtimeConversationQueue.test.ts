import { describe, expect, it, vi } from 'vitest'
import {
  RuntimeConversationQueue,
  runtimeQueuedMessageRequest,
  type RuntimeConversationQueuePort,
} from './runtimeConversationQueue'
import type { RuntimePaneQueuedMessage } from '@wegent/chat-core/conversation-queue'

const message = (id: string): RuntimePaneQueuedMessage => ({
  id,
  content: `Message ${id}`,
  status: 'queued',
  createdAt: '2026-09-17T00:00:00Z',
})
function setup() {
  let revision = 0
  const queue = new RuntimeConversationQueue<number>()
  const port: RuntimeConversationQueuePort<number> = {
    send: vi.fn().mockResolvedValue({ sent: true }),
    guide: vi.fn().mockResolvedValue({ sent: true }),
    lifecycle: () => revision,
    lifecycleChanged: previous => previous !== revision,
    isBusyError: error => error === 'busy',
    sendFailedText: 'Send failed',
    guidanceFailedText: 'Guide failed',
  }
  return { queue, port, transition: () => revision++ }
}
const applied = (id: string) => ({
  guidanceId: `server-${id}`,
  clientGuidanceId: id,
  message: `Message ${id}`,
  appliedAtMs: 1,
})

describe('shared PC and Web conversation queue', () => {
  it('waits while busy and dispatches FIFO once per confirmed lifecycle transition', async () => {
    const { queue, port, transition } = setup()
    queue.enqueue(message('one'))
    queue.enqueue(message('two'))
    await queue.pump(port, true)
    expect(port.send).not.toHaveBeenCalled()
    await queue.pump(port, false)
    expect(port.send).toHaveBeenCalledWith(message('one'))
    await queue.pump(port, false)
    expect(port.send).toHaveBeenCalledTimes(1)
    transition()
    await queue.pump(port, false)
    expect(port.send).toHaveBeenLastCalledWith(message('two'))
    expect(queue.getSnapshot()).toEqual([])
  })
  it.each(['response', 'exception'])(
    'keeps a busy %s queued without retry loops until a state change',
    async kind => {
      const { queue, port, transition } = setup()
      if (kind === 'response')
        vi.mocked(port.send).mockResolvedValueOnce({ sent: false, error: 'busy' })
      else vi.mocked(port.send).mockRejectedValueOnce(new Error('busy'))
      queue.enqueue(message('one'))
      await queue.pump(port, false)
      expect(queue.getSnapshot()[0]).toMatchObject({ status: 'queued', error: undefined })
      await queue.pump(port, false)
      expect(port.send).toHaveBeenCalledTimes(1)
      transition()
      await queue.pump(port, false)
      expect(queue.getSnapshot()).toEqual([])
    }
  )
  it('prevents duplicate dispatch and editing or removing an in-flight message', async () => {
    const { queue, port } = setup()
    let finish!: (result: { sent: boolean }) => void
    vi.mocked(port.send).mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    queue.enqueue(message('one'))
    const sending = queue.pump(port, false)
    await queue.pump(port, false)
    queue.cancel('one')
    expect(queue.take('one')).toBeNull()
    expect(port.send).toHaveBeenCalledTimes(1)
    finish({ sent: true })
    await sending
    expect(queue.getSnapshot()).toEqual([])
  })
  it('retains non-busy failures for editing and restores the original attachment and model payload', async () => {
    const { queue, port } = setup()
    vi.mocked(port.send).mockRejectedValueOnce(new Error('Device offline'))
    const pending = {
      ...message('one'),
      modelId: 'chosen-model',
      modelOptions: { reasoningEffort: 'high' },
      attachments: [{ id: 3, filename: 'a.png' }],
    }
    queue.enqueue(pending)
    await queue.pump(port, false)
    expect(queue.getSnapshot()[0]).toMatchObject({ status: 'failed', error: 'Device offline' })
    await queue.pump(port, false)
    expect(port.send).toHaveBeenCalledTimes(1)
    expect(queue.take('one')).toMatchObject({ ...pending, status: 'failed' })
    expect(queue.getSnapshot()).toEqual([])
  })
  it('keeps accepted guidance visible until applied and handles an applied event before the response', async () => {
    const { queue, port } = setup()
    queue.enqueue(message('one'))
    await queue.guide('one', port, true)
    expect(queue.getSnapshot()[0]).toMatchObject({ status: 'sending', deliveryMode: 'guidance' })
    expect(queue.applyGuidance(applied('unrelated'))).toBeNull()
    expect(queue.applyGuidance(applied('one'))?.id).toBe('one')
    queue.enqueue(message('two'))
    vi.mocked(port.guide).mockImplementationOnce(async () => {
      queue.applyGuidance(applied('two'))
      return { sent: true }
    })
    await queue.guide('two', port, true)
    expect(queue.getSnapshot()).toEqual([])
  })
  it('exposes rejected guidance and reconciles applied guidance recovered from canonical history', async () => {
    const { queue, port } = setup()
    queue.enqueue(message('one'))
    vi.mocked(port.guide).mockResolvedValueOnce({ sent: false, error: 'Question closed' })
    await queue.guide('one', port, true)
    expect(queue.getSnapshot()[0]).toMatchObject({
      status: 'failed',
      error: 'Question closed',
      deliveryMode: undefined,
    })
    await queue.guide('one', port, true)
    queue.reconcileGuidance(new Set(['one']))
    expect(queue.getSnapshot()).toEqual([])
  })
  it('addresses remote and local attachments correctly and freezes the submitted model selection', () => {
    const request = runtimeQueuedMessageRequest(
      {
        address: { deviceId: 'device', taskId: 'task' },
        modelId: 'changed-after-enqueue',
        modelSelection: { modelName: 'changed-after-enqueue', options: {} },
      },
      {
        ...message('one'),
        modelId: 'original',
        modelType: 'user',
        modelOptions: { weworkCloudModelNamespace: 'team', weworkCloudModelResourceUserId: '42' },
        attachments: [
          { id: 3, filename: 'cloud.txt' },
          { id: -1, filename: 'local.txt', local_path: '/repo/local.txt', text_content: 'ui-only' },
        ],
      }
    )
    expect(request).toMatchObject({
      clientUserMessageId: 'one',
      modelSelection: {
        modelName: 'original',
        modelType: 'user',
        options: { weworkCloudModelNamespace: 'team', weworkCloudModelResourceUserId: '42' },
      },
      attachmentIds: [3],
      attachments: [{ id: -1, local_path: '/repo/local.txt' }],
    })
    expect(request.attachments?.[0].text_content).toBeUndefined()
  })
})
