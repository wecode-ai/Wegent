import { describe, expect, it, vi } from 'vitest'
import {
  ReplyPredictionService,
  predictionPrompt,
  predictionTurns,
  type ReplyPredictionSource,
  type ReplyPredictionTurn,
} from './replyPredictionService'

const model = {
  modelName: 'prediction',
  modelType: 'public',
  executionModelId: 'predictor',
  executionModelType: 'public',
}
const turns: ReplyPredictionTurn[] = [
  {
    id: 'turn-1',
    status: 'completed',
    user: '不要中断任务',
    assistant: '可以迁移正在运行的进程。',
  },
]
const source = (): ReplyPredictionSource => ({
  scope: 'task-1',
  revision: 'revision-1',
  busy: false,
  load: vi.fn(async () => turns),
})

describe('reply prediction service', () => {
  it('predicts from canonical completed runtime turns and rejects partial or running transcripts', () => {
    const transcript = {
      fullContent: true,
      running: false,
      messages: [],
      turns: [
        {
          id: 'completed-runtime-turn',
          status: 'done' as const,
          items: [
            {
              id: 'user',
              type: 'user_message' as const,
              message: {
                id: 'user',
                role: 'user' as const,
                content: '保留运行中的任务',
                createdAt: '',
              },
            },
            {
              id: 'assistant',
              type: 'assistant_text' as const,
              content: '可以迁移进程',
              createdAt: '',
            },
          ],
        },
      ],
    }
    expect(predictionPrompt(predictionTurns(transcript))).toContain('保留运行中的任务')
    expect(predictionTurns({ ...transcript, running: true })).toEqual([])
    expect(predictionTurns({ ...transcript, fullContent: false })).toEqual([])
  })
  it('deduplicates generation and never reoffers an accepted suggestion', async () => {
    const generateText = vi.fn(async () => '{"suggestion":"请迁移，保留运行中的任务。"}')
    const service = new ReplyPredictionService({ generateText })
    service.configure(model)
    const context = source()
    const [first, second] = await Promise.all([
      service.request(context, model),
      service.request(context, model),
    ])
    expect(context.load).toHaveBeenCalledTimes(1)
    expect(generateText).toHaveBeenCalledTimes(1)
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'predictor',
        timeoutMs: 30000,
        signal: expect.any(AbortSignal),
      })
    )
    expect(first?.text).toBe(second?.text)
    first!.onAccept()
    expect(await service.request(context, model)).toBeNull()
  })

  it('aborts pending work and ignores a late result after a new turn or model change', async () => {
    let resolve!: (value: string) => void
    const generateText = vi.fn(
      () =>
        new Promise<string>(done => {
          resolve = done
        })
    )
    const service = new ReplyPredictionService({ generateText })
    service.configure(model)
    const pending = service.request(source(), model)
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1))
    const signal = generateText.mock.calls[0][0].signal!
    service.invalidate('task-1')
    expect(signal.aborted).toBe(true)
    resolve('{"suggestion":"迟到结果"}')
    expect(await pending).toBeNull()
    service.configure(null)
  })

  it('does not retry errors or null results and isolates conversations', async () => {
    const generateText = vi.fn(async () => {
      throw new Error('offline')
    })
    const service = new ReplyPredictionService({ generateText })
    service.configure(model)
    const context = source()
    expect(await service.request(context, model)).toBeNull()
    expect(await service.request(context, model)).toBeNull()
    expect(generateText).toHaveBeenCalledTimes(1)
    expect(await service.request({ ...source(), scope: 'task-2' }, model)).toBeNull()
    expect(generateText).toHaveBeenCalledTimes(2)
  })

  it('does not generate for incomplete turns and keeps original constraints in bounded context', () => {
    expect(predictionPrompt([{ ...turns[0], status: 'interrupted' }])).toBeNull()
    const history = Array.from({ length: 12 }, (_, index) => ({
      ...turns[0],
      id: String(index),
      user: index === 0 ? '保留所有数据' : `第${index}轮`,
    }))
    const prompt = predictionPrompt(history)!
    expect(prompt).toContain('保留所有数据')
    expect(prompt).toContain('第11轮')
    expect(prompt).not.toContain('第1轮')
    expect(predictionPrompt([{ ...turns[0], assistant: 'x'.repeat(24000) }])).toBeNull()
  })
})
