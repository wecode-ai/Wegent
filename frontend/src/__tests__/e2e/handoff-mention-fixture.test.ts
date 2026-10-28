/** @jest-environment node */

import { prepareProjectMentionTasks } from '../../../e2e/utils/handoff-mention-fixture'

interface ProjectTask {
  task_id: number
  task_title: string
  task_status: string
  updated_at?: string | null
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

function fixture({ serverOffset = 0, naiveTimestamps = false, precision = Math.round } = {}) {
  const timestamp = (offset: number) => {
    const value = new Date(
      precision((Date.now() + serverOffset + offset) / 1_000) * 1_000
    ).toISOString()
    return naiveTimestamps ? value.slice(0, -1) : value
  }
  const tasks: ProjectTask[] = [
    {
      task_id: 421,
      task_title: 'Project handoff target',
      task_status: 'COMPLETED',
      updated_at: timestamp(-2_000),
    },
    {
      task_id: 423,
      task_title: 'Project filler one',
      task_status: 'COMPLETED',
      updated_at: timestamp(-1_000),
    },
    {
      task_id: 425,
      task_title: 'Project filler two',
      task_status: 'COMPLETED',
      updated_at: timestamp(0),
    },
  ]
  return {
    tasks,
    taskIds: [421, 423, 425],
    visibleTasks: [{ taskId: 421, title: tasks[0].task_title }],
    waitForCompleted: jest.fn(async (_taskId: number): Promise<void> => {}),
    touchTask: jest.fn(async (task: { taskId: number; title: string }): Promise<void> => {
      tasks.find(item => item.task_id === task.taskId)!.updated_at = timestamp(0)
    }),
    readProjectTasks: jest.fn(async () => tasks.map(task => ({ ...task }))),
  }
}

describe('project handoff mention fixture preparation', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(Date.parse('2026-10-28T08:44:08.250Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('waits for every completion and a full precision interval before touching once', async () => {
    const input = fixture()
    const completions = input.taskIds.map(() => deferred())
    input.waitForCompleted.mockImplementation(taskId => {
      return completions[input.taskIds.indexOf(taskId)].promise
    })
    const preparing = prepareProjectMentionTasks(input)

    expect(input.waitForCompleted.mock.calls.map(([taskId]) => taskId)).toEqual(input.taskIds)
    completions[0].resolve()
    await jest.advanceTimersByTimeAsync(2_000)
    expect(input.touchTask).not.toHaveBeenCalled()
    expect(input.readProjectTasks).not.toHaveBeenCalled()

    completions[1].resolve()
    expect(input.waitForCompleted.mock.calls.map(([taskId]) => taskId)).toEqual(input.taskIds)
    await jest.advanceTimersByTimeAsync(2_000)
    expect(input.touchTask).not.toHaveBeenCalled()

    input.tasks[2].updated_at = new Date(Math.round(Date.now() / 1_000) * 1_000).toISOString()
    completions[2].resolve()
    await jest.advanceTimersByTimeAsync(0)
    expect(input.readProjectTasks).not.toHaveBeenCalled()
    expect(input.touchTask).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1_099)
    expect(input.touchTask).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(1)
    await preparing
    expect(input.touchTask.mock.calls).toEqual([[input.visibleTasks[0]]])
    expect(input.readProjectTasks).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(5_000)
    expect(input.touchTask).toHaveBeenCalledTimes(1)
  })

  it('allows two visible controls in the same second when every filler is older', async () => {
    const input = fixture()
    input.visibleTasks.push({ taskId: 425, title: input.tasks[2].task_title })
    const preparing = prepareProjectMentionTasks(input)

    await jest.runAllTimersAsync()
    await preparing

    expect(input.waitForCompleted.mock.calls.map(([taskId]) => taskId)).toEqual(input.taskIds)
    expect(input.touchTask.mock.calls).toEqual(input.visibleTasks.map(task => [task]))
    expect(input.readProjectTasks).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: 'rounded', precision: Math.round },
    { name: 'truncated', precision: Math.floor },
  ])(
    'handles MySQL $name completion timestamps after the half-second mark',
    async ({ precision }) => {
      jest.setSystemTime(Date.parse('2026-10-28T08:44:08.586Z'))
      const startedAt = Date.now()
      const input = fixture({ precision })
      const result = prepareProjectMentionTasks(input).then(
        () => null,
        error => error
      )

      await jest.runAllTimersAsync()

      expect(await result).toBeNull()
      expect(input.touchTask).toHaveBeenCalledTimes(1)
      expect(input.readProjectTasks).toHaveBeenCalledTimes(1)
      expect(Date.now() - startedAt).toBe(1_100)
      expect(Date.parse(input.tasks[0].updated_at!)).toBeGreaterThan(
        Date.parse(input.tasks[2].updated_at!)
      )
    }
  )

  it.each([
    { serverOffset: 5 * 60_000, naiveTimestamps: false },
    { serverOffset: -5 * 60_000, naiveTimestamps: false },
    { serverOffset: 8 * 3_600_000, naiveTimestamps: true },
    { serverOffset: 0, naiveTimestamps: true },
  ])(
    'preserves relative ordering across server clock and timezone differences: %o',
    async options => {
      jest.setSystemTime(Date.parse('2026-10-28T08:44:08.586Z'))
      const input = fixture(options)
      const result = prepareProjectMentionTasks(input).then(
        () => null,
        error => error
      )

      await jest.runAllTimersAsync()

      expect(await result).toBeNull()
      expect(input.touchTask).toHaveBeenCalledTimes(1)
      expect(input.readProjectTasks).toHaveBeenCalledTimes(1)
      expect(Date.parse(input.tasks[0].updated_at!)).toBeGreaterThan(
        Date.parse(input.tasks[2].updated_at!)
      )
    }
  )

  it.each<[string, (tasks: ProjectTask[]) => void, RegExp]>([
    [
      'a target and a filler tied at second precision despite different milliseconds',
      tasks => {
        tasks[2].updated_at = new Date(Date.parse(tasks[0].updated_at!) + 200).toISOString()
      },
      /must sort ahead of every filler/,
    ],
    [
      'an older target',
      tasks => {
        tasks[0].updated_at = '2026-10-28T08:44:06.000Z'
      },
      /must sort ahead of every filler/,
    ],
    [
      'a filler updated asynchronously after the ordering barrier',
      tasks => {
        tasks[2].updated_at = new Date(Date.parse(tasks[0].updated_at!) + 2_000).toISOString()
      },
      /must sort ahead of every filler/,
    ],
    [
      'a missing target',
      tasks => {
        tasks.shift()
      },
      /must be present exactly once/,
    ],
    [
      'a missing filler',
      tasks => {
        tasks.pop()
      },
      /must be present exactly once/,
    ],
    [
      'a duplicated fixture record',
      tasks => {
        tasks.push({ ...tasks[1] })
      },
      /must be present exactly once/,
    ],
    [
      'a filler that is still running',
      tasks => {
        tasks[2].task_status = 'RUNNING'
      },
      /Fixture task 425 is not complete/,
    ],
    [
      'a failed target',
      tasks => {
        tasks[0].task_status = 'FAILED'
      },
      /Fixture task 421 is not complete/,
    ],
    [
      'a late title change',
      tasks => {
        tasks[0].task_title = 'Overwritten by background processing'
      },
      /mention fixture title changed/,
    ],
    [
      'an invalid target update time',
      tasks => {
        tasks[0].updated_at = 'not-a-date'
      },
      /no valid ordering timestamp/,
    ],
    [
      'a missing filler update time',
      tasks => {
        tasks[2].updated_at = null
      },
      /no valid ordering timestamp/,
    ],
  ])('rejects %s without touching again to manufacture a pass', async (_name, damage, message) => {
    const input = fixture()
    // Damage only the final projection; expected identities and titles stay intact.
    const originalRead = input.readProjectTasks.getMockImplementation()!
    input.readProjectTasks.mockImplementation(async () => {
      damage(input.tasks)
      return originalRead()
    })
    const result = prepareProjectMentionTasks(input).then(
      () => null,
      error => error
    )

    await jest.runAllTimersAsync()
    const error = await result
    expect(error).toMatchObject({ name: 'AssertionError', message: expect.stringMatching(message) })

    expect(input.touchTask).toHaveBeenCalledTimes(1)
    expect(input.readProjectTasks).toHaveBeenCalledTimes(1)
  })

  it('propagates a completion failure before starting the precision interval or touching', async () => {
    const input = fixture()
    const failure = new Error('Fixture task failed to complete')
    input.waitForCompleted.mockRejectedValueOnce(failure)

    await expect(prepareProjectMentionTasks(input)).rejects.toBe(failure)

    expect(input.touchTask).not.toHaveBeenCalled()
    expect(input.readProjectTasks).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each(['touch', 'read'] as const)('propagates a %s failure without retrying', async stage => {
    const input = fixture()
    const failure = new Error(`${stage} failed`)
    if (stage === 'touch') input.touchTask.mockRejectedValueOnce(failure)
    else input.readProjectTasks.mockRejectedValueOnce(failure)
    const result = prepareProjectMentionTasks(input).then(
      () => null,
      error => error
    )

    await jest.runAllTimersAsync()
    expect(await result).toBe(failure)

    expect(input.touchTask).toHaveBeenCalledTimes(1)
    expect(input.readProjectTasks).toHaveBeenCalledTimes(stage === 'read' ? 1 : 0)
  })
})
