import { describe, expect, it, vi } from 'vitest'
import { ReplyPredictionService, type ReplyPredictionSource } from './replyPredictionService'

const source = (): ReplyPredictionSource => ({
  scope: 'task-1',
  revision: 'revision-1',
  latestTurnId: 'turn-1',
  busy: false,
  address: { deviceId: 'device-1', taskId: 'task-1' },
})

describe('reply prediction service', () => {
  it('deduplicates the same turn and never reoffers an accepted suggestion', async () => {
    const predict = vi.fn(async () => ({ suggestion: ' 请保留任务并迁移。 ' }))
    const service = new ReplyPredictionService({ predict })
    const [first, second] = await Promise.all([
      service.request(source()),
      service.request(source()),
    ])
    expect(predict).toHaveBeenCalledTimes(1)
    expect(predict).toHaveBeenCalledWith({
      address: source().address,
      latestTurnId: 'turn-1',
      signal: expect.any(AbortSignal),
    })
    expect(first?.text).toBe('请保留任务并迁移。')
    expect(second?.text).toBe(first?.text)
    first!.onAccept()
    expect(second!.isCurrent()).toBe(false)
    expect(await service.request({ ...source(), revision: 'updated-metadata' })).toBeNull()
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it('aborts a superseded turn and ignores its late result', async () => {
    const resolvers: Array<(value: { suggestion: string | null }) => void> = []
    const predict = vi.fn<
      (data: { signal?: AbortSignal }) => Promise<{ suggestion: string | null }>
    >(() => new Promise<{ suggestion: string | null }>(resolve => resolvers.push(resolve)))
    const service = new ReplyPredictionService({ predict })
    const old = service.request(source())
    const next = service.request({ ...source(), latestTurnId: 'turn-2' })
    expect(predict.mock.calls[0][0].signal!.aborted).toBe(true)
    resolvers[0]({ suggestion: '过期建议' })
    resolvers[1]({ suggestion: '新的建议' })
    expect(await old).toBeNull()
    expect((await next)?.text).toBe('新的建议')
  })

  it('does not retry failures or null predictions and isolates conversations', async () => {
    const predict = vi.fn(async () => {
      throw new Error('unsupported prediction mode')
    })
    const service = new ReplyPredictionService({ predict })
    expect(await service.request(source())).toBeNull()
    expect(await service.request(source())).toBeNull()
    expect(predict).toHaveBeenCalledTimes(1)
    expect(await service.request({ ...source(), scope: 'task-2' })).toBeNull()
    expect(predict).toHaveBeenCalledTimes(2)
    const empty = vi.fn(async () => ({ suggestion: null }))
    const emptyService = new ReplyPredictionService({ predict: empty })
    expect(await emptyService.request(source())).toBeNull()
    expect(await emptyService.request(source())).toBeNull()
    expect(empty).toHaveBeenCalledTimes(1)
  })

  it('does not predict busy turns and cancels only after the last composer releases', async () => {
    const predict = vi.fn<
      (data: { signal?: AbortSignal }) => Promise<{ suggestion: string | null }>
    >(() => new Promise<{ suggestion: string | null }>(() => {}))
    const service = new ReplyPredictionService({ predict })
    expect(await service.request({ ...source(), busy: true })).toBeNull()
    expect(predict).not.toHaveBeenCalled()
    const first = service.retain(source().scope)
    const second = service.retain(source().scope)
    void service.request(source())
    first()
    expect(predict.mock.calls[0][0].signal!.aborted).toBe(false)
    second()
    expect(predict.mock.calls[0][0].signal!.aborted).toBe(true)
  })
})
