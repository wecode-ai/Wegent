import {
  cleanupFixtureStages,
  forEachTaskFixtureBatch,
  settleMentionTasks,
} from '../../../e2e/utils/mention-task-fixtures'

describe('mention task fixtures', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(1250)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('waits for every completion callback before advancing the timestamp second', async () => {
    const completions = new Map<number, () => void>()
    const waitForTerminal = jest.fn(
      (id: number) =>
        new Promise<void>(resolve => {
          completions.set(id, resolve)
        })
    )
    let ready = false
    const result = settleMentionTasks([421, 531], waitForTerminal).then(() => {
      ready = true
    })

    completions.get(421)!()
    await jest.advanceTimersByTimeAsync(1000)
    expect(ready).toBe(false)
    expect(jest.getTimerCount()).toBe(0)

    completions.get(531)!()
    await jest.advanceTimersByTimeAsync(0)
    await jest.advanceTimersByTimeAsync(750)
    expect(ready).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await result

    expect(ready).toBe(true)
    expect(Date.now()).toBe(3001)
  })

  it('bounds status requests instead of polling every fixture concurrently', async () => {
    const completions: Array<() => void> = []
    const waitForTerminal = jest.fn(
      () =>
        new Promise<void>(resolve => {
          completions.push(resolve)
        })
    )
    const result = settleMentionTasks(
      Array.from({ length: 17 }, (_, index) => index),
      waitForTerminal
    )
    expect(waitForTerminal).toHaveBeenCalledTimes(8)

    completions.splice(0).forEach(resolve => resolve())
    await jest.advanceTimersByTimeAsync(0)
    expect(waitForTerminal).toHaveBeenCalledTimes(16)
    completions.splice(0).forEach(resolve => resolve())
    await jest.advanceTimersByTimeAsync(0)
    expect(waitForTerminal).toHaveBeenCalledTimes(17)
    completions.splice(0).forEach(resolve => resolve())
    await jest.advanceTimersByTimeAsync(1000)
    await result
  })

  it('runs cleanup batches without the mention-order timestamp delay', async () => {
    const clean = jest.fn().mockResolvedValue(undefined)
    await forEachTaskFixtureBatch(
      Array.from({ length: 17 }, (_, index) => index),
      clean
    )
    expect(clean).toHaveBeenCalledTimes(17)
    expect(jest.getTimerCount()).toBe(0)
    expect(Date.now()).toBe(1250)
  })

  it('drains in-flight deletions before exposing a batch failure', async () => {
    const failure = new Error('Delete failed')
    const finish: Array<() => void> = []
    const clean = jest.fn((id: number) =>
      id === 0 ? Promise.reject(failure) : new Promise<void>(resolve => finish.push(resolve))
    )
    let reported: unknown
    const result = forEachTaskFixtureBatch(
      Array.from({ length: 9 }, (_, id) => id),
      clean
    ).catch(error => {
      reported = error
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(reported).toBeUndefined()
    expect(clean).toHaveBeenCalledTimes(8)
    finish.forEach(resolve => resolve())
    await result
    expect(reported).toBe(failure)
    expect(clean).toHaveBeenCalledTimes(8)
  })

  it('preserves cleanup failures and does not start the next batch', async () => {
    const clean = jest.fn().mockRejectedValue(new Error('Cleanup failed'))
    await expect(
      forEachTaskFixtureBatch(
        Array.from({ length: 17 }, (_, index) => index),
        clean
      )
    ).rejects.toThrow('Cleanup failed')
    expect(clean).toHaveBeenCalledTimes(8)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('attempts every independent cleanup and preserves all stage failures', async () => {
    const failures = [new Error('Task deletion failed'), new Error('Account cleanup failed')]
    const order: string[] = []
    let reported: unknown
    await cleanupFixtureStages([
      async () => {
        order.push('tasks')
        throw failures[0]
      },
      async () => {
        order.push('projects')
      },
      async () => {
        order.push('accounts')
        throw failures[1]
      },
      async () => {
        order.push('resources')
      },
    ]).catch(error => {
      reported = error
    })
    expect(order).toEqual(['tasks', 'projects', 'accounts', 'resources'])
    expect(reported).toBeInstanceOf(AggregateError)
    expect((reported as AggregateError).errors).toEqual(failures)
  })

  it('surfaces fixture execution failures without retrying or touching timestamps', async () => {
    const waitForTerminal = jest.fn().mockRejectedValue(new Error('Fixture task failed'))
    await expect(settleMentionTasks([421], waitForTerminal)).rejects.toThrow('Fixture task failed')
    expect(waitForTerminal).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })
})
