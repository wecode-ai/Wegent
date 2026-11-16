import { beforeEach, expect, test, vi } from 'vitest'
import { scheduleIdleTask, type IdleTask } from '@/features/idle-tasks/idleTaskScheduler'
import { createPluginBackgroundPass } from './pluginBackgroundPass'

vi.mock('@/features/idle-tasks/idleTaskScheduler', () => ({ scheduleIdleTask: vi.fn() }))

let queued: IdleTask[]
beforeEach(() => {
  queued = []
  vi.mocked(scheduleIdleTask).mockImplementation((_id, task) => {
    queued.push(task)
    return vi.fn()
  })
})

test.each([true, false])(
  'shared serial idle dispatch is released during HTTP work only in local mode: %s',
  async detached => {
    let finish!: (value: boolean) => void
    const blocked = new Promise<boolean>(resolve => {
      finish = resolve
    })
    const next = vi.fn(async () => false)
    const options = { isCurrent: () => true, onError: vi.fn(), detached }
    const first = createPluginBackgroundPass({ ...options, id: 'first', run: () => blocked })
    const second = createPluginBackgroundPass({ ...options, id: 'second', run: next })
    first.request()
    second.request()
    const dispatch = async () => {
      for (const task of queued) await task()
    }
    const running = dispatch()
    try {
      if (detached) await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
      else {
        await Promise.resolve()
        expect(next).not.toHaveBeenCalled()
      }
    } finally {
      finish(false)
      await running
      first.dispose()
      second.dispose()
    }
    expect(next).toHaveBeenCalledOnce()
    expect(options.onError).not.toHaveBeenCalled()
  }
)
