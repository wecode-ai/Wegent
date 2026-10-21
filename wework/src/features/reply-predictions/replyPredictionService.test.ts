import { describe, expect, it, vi } from 'vitest'
import {
  deleteReplyPredictions,
  ReplyPredictionService,
  type ReplyPredictionSource,
} from './replyPredictionService'
import { readReplyPrediction } from './replyPredictionCache'
import { replyPredictionKey } from './replyPredictionService'

const source = (): ReplyPredictionSource => ({
  scope: 'task-1',
  revision: 'revision-1',
  latestTurnId: 'turn-1',
  busy: false,
  address: { deviceId: 'device-1', taskId: 'task-1' },
})

describe('reply prediction service', () => {
  it('deletes persisted and in-memory results across API instances without affecting other tasks', async () => {
    const task = {
      ...source(),
      scope: JSON.stringify(['device-1', 'task-1', '/workspace']),
    }
    const other = {
      ...task,
      scope: JSON.stringify(['device-2', 'task-1', '/workspace']),
      address: { ...task.address, deviceId: 'device-2' },
    }
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    const first = new ReplyPredictionService({ predict })
    const second = new ReplyPredictionService({ predict })
    const suggestion = await first.request(task)
    const secondSuggestion = await second.request(task)
    const otherSuggestion = await first.request(other)

    deleteReplyPredictions(task.address)

    expect(suggestion!.isCurrent()).toBe(false)
    expect(secondSuggestion!.isCurrent()).toBe(false)
    expect(otherSuggestion!.isCurrent()).toBe(true)
    expect(readReplyPrediction(task.scope, replyPredictionKey(task))).toBeNull()
    expect(readReplyPrediction(other.scope, replyPredictionKey(other))?.text).toBe('请继续')
    suggestion!.onAccept()
    expect(readReplyPrediction(task.scope, replyPredictionKey(task))).toBeNull()
  })

  it('cancels deletion-time generation and prevents a late response from recreating the cache', async () => {
    let resolve!: (value: { suggestion: string }) => void
    const predict = vi.fn<(data: { signal?: AbortSignal }) => Promise<{ suggestion: string }>>(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const task = { ...source(), scope: JSON.stringify(['device-1', 'task-1', null]) }
    const service = new ReplyPredictionService({ predict })
    const request = service.request(task)

    deleteReplyPredictions(task.address)
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(true)
    expect(service.isPending(task.scope)).toBe(false)
    resolve({ suggestion: '删除后的迟到建议' })

    expect(await request).toBeNull()
    expect(readReplyPrediction(task.scope, replyPredictionKey(task))).toBeNull()
  })

  it('restores suggestions after a restart and persists acceptance', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    await new ReplyPredictionService({ predict }).request(source())

    const restored = new ReplyPredictionService({ predict })
    expect(restored.isPending(source().scope)).toBe(false)
    const suggestion = await restored.request(source())
    expect(suggestion?.text).toBe('请继续')
    expect(predict).toHaveBeenCalledTimes(1)
    suggestion!.onAccept()

    expect(await new ReplyPredictionService({ predict }).request(source())).toBeNull()
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it.each(['empty', 'failure'] as const)(
    'restores a completed %s result without spending tokens again',
    async state => {
      const predict = vi.fn(async () => {
        if (state === 'failure') throw new Error('provider unavailable')
        return { suggestion: null }
      })
      await new ReplyPredictionService({ predict }).request(source())

      const restored = new ReplyPredictionService({ predict })
      expect(await restored.request(source())).toBeNull()
      expect(restored.hasError(source().scope)).toBe(state === 'failure')
      expect(predict).toHaveBeenCalledTimes(1)
    }
  )

  it('generates for a new turn, model or conversation after a restart', async () => {
    const predict = vi.fn(async () => ({ suggestion: '请继续' }))
    await new ReplyPredictionService({ predict }).request(source())
    await new ReplyPredictionService({ predict }).request({ ...source(), latestTurnId: 'turn-2' })
    await new ReplyPredictionService({ predict }).request({
      ...source(),
      latestTurnId: 'turn-2',
      modelSelection: { modelName: 'new-model', modelType: 'runtime' },
    })
    await new ReplyPredictionService({ predict }).request({ ...source(), scope: 'task-2' })
    expect(predict).toHaveBeenCalledTimes(4)
  })

  it('does not let a cancelled response overwrite the persisted current turn', async () => {
    let resolve!: (value: { suggestion: string }) => void
    const predict = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(done => {
            resolve = done
          })
      )
      .mockResolvedValue({ suggestion: '新的建议' })
    const service = new ReplyPredictionService({ predict })
    const old = service.request(source())
    const current = { ...source(), latestTurnId: 'turn-2' }
    await service.request(current)
    resolve({ suggestion: '过期建议' })
    expect(await old).toBeNull()

    expect((await new ReplyPredictionService({ predict }).request(current))?.text).toBe('新的建议')
    expect(predict).toHaveBeenCalledTimes(2)
  })

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

  it('keeps equivalent nested model selections pending and restores their shared cache', async () => {
    let resolve!: (value: { suggestion: string }) => void
    const predict = vi.fn<(data: { signal?: AbortSignal }) => Promise<{ suggestion: string }>>(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const original = {
      ...source(),
      modelSelection: {
        modelName: 'session-model',
        modelType: 'runtime' as const,
        options: { speed: 'standard', reasoning: 'low' },
      },
    }
    const refreshed = {
      ...original,
      modelSelection: {
        options: { reasoning: 'low', speed: 'standard' },
        modelType: 'runtime' as const,
        modelName: 'session-model',
      },
    }
    const service = new ReplyPredictionService({ predict })
    const first = service.request(original)
    const second = service.request(refreshed)

    expect(predict).toHaveBeenCalledTimes(1)
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(false)
    resolve({ suggestion: '保留当前建议' })
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult?.text).toBe('保留当前建议')
    expect(secondResult?.text).toBe(firstResult?.text)
    expect((await new ReplyPredictionService({ predict }).request(refreshed))?.text).toBe(
      '保留当前建议'
    )
    expect(predict).toHaveBeenCalledTimes(1)
    firstResult!.onAccept()
    expect(await new ReplyPredictionService({ predict }).request(refreshed)).toBeNull()
    expect(predict).toHaveBeenCalledTimes(1)
  })

  it('preserves absent, empty and null model fields in prediction identity', () => {
    const withoutSelection = replyPredictionKey(source())
    expect(replyPredictionKey({ ...source(), modelSelection: undefined })).toBe(withoutSelection)
    expect(replyPredictionKey({ ...source(), modelSelection: null })).toBe(withoutSelection)
    const selected = { ...source(), modelSelection: { modelName: 'session-model' } }
    const selectedKey = replyPredictionKey(selected)
    expect(
      replyPredictionKey({
        ...selected,
        modelSelection: { ...selected.modelSelection, modelType: undefined, options: undefined },
      })
    ).toBe(selectedKey)
    expect(
      replyPredictionKey({
        ...selected,
        modelSelection: { ...selected.modelSelection, modelType: null },
      })
    ).not.toBe(selectedKey)
    expect(
      replyPredictionKey({
        ...selected,
        modelSelection: { ...selected.modelSelection, options: {} },
      })
    ).not.toBe(selectedKey)
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

  it('cancels an old model configuration and ignores its late failure', async () => {
    const resolvers: Array<(value: { suggestion: string }) => void> = []
    const rejectors: Array<(reason: Error) => void> = []
    const predict = vi.fn<(data: { signal?: AbortSignal }) => Promise<{ suggestion: string }>>(
      () =>
        new Promise((resolve, reject) => {
          resolvers.push(resolve)
          rejectors.push(reject)
        })
    )
    const service = new ReplyPredictionService({ predict })
    const original = {
      ...source(),
      modelSelection: {
        modelName: 'session-model',
        modelType: 'runtime' as const,
        options: { reasoningEffort: 'low' },
      },
    }
    const old = service.request(original)
    const updated = {
      ...original,
      modelSelection: { ...original.modelSelection, options: { reasoningEffort: 'high' } },
    }
    const next = service.request(updated)
    expect(predict.mock.calls[0][0].signal?.aborted).toBe(true)
    rejectors[0](new Error('Old credentials rejected'))
    resolvers[1]({ suggestion: '当前配置的建议' })
    expect(await old).toBeNull()
    expect((await next)?.text).toBe('当前配置的建议')
    expect(service.hasError(original.scope)).toBe(false)
    expect((await service.request({ ...updated }))?.text).toBe('当前配置的建议')
    expect(predict).toHaveBeenCalledTimes(2)
  })

  it('does not retry failures or null predictions and isolates conversations', async () => {
    const predict = vi.fn(async () => {
      throw new Error('unsupported prediction mode')
    })
    const service = new ReplyPredictionService({ predict })
    expect(await service.request(source())).toBeNull()
    expect(await service.request(source())).toBeNull()
    expect(service.hasError(source().scope)).toBe(true)
    expect(predict).toHaveBeenCalledTimes(1)
    expect(await service.request({ ...source(), scope: 'task-2' })).toBeNull()
    expect(predict).toHaveBeenCalledTimes(2)
    const empty = vi.fn(async () => ({ suggestion: null }))
    const emptyService = new ReplyPredictionService({ predict: empty })
    const emptySource = { ...source(), scope: 'task-empty' }
    expect(await emptyService.request(emptySource)).toBeNull()
    expect(await emptyService.request(emptySource)).toBeNull()
    expect(empty).toHaveBeenCalledTimes(1)
    expect(emptyService.hasError(emptySource.scope)).toBe(false)
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
