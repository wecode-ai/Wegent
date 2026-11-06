import { settleMentionTasks } from '../../../e2e/utils/mention-task-fixtures'

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

  it('surfaces fixture execution failures without retrying or touching timestamps', async () => {
    const waitForTerminal = jest.fn().mockRejectedValue(new Error('Fixture task failed'))
    await expect(settleMentionTasks([421], waitForTerminal)).rejects.toThrow('Fixture task failed')
    expect(waitForTerminal).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })
})
