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

function fixture() {
  const tasks: ProjectTask[] = [
    {
      task_id: 421,
      task_title: 'Project handoff target',
      task_status: 'COMPLETED',
      updated_at: '2026-10-28T05:01:39.000Z',
    },
    {
      task_id: 423,
      task_title: 'Project filler one',
      task_status: 'COMPLETED',
      updated_at: '2026-10-28T05:01:37.000Z',
    },
    {
      task_id: 425,
      task_title: 'Project filler two',
      task_status: 'COMPLETED',
      updated_at: '2026-10-28T05:01:38.000Z',
    },
  ]
  return {
    tasks,
    taskIds: [421, 423, 425],
    visibleTasks: [{ taskId: 421, title: tasks[0].task_title }],
    waitForCompleted: jest.fn(async (_taskId: number): Promise<void> => {}),
    touchTask: jest.fn(async (_task: { taskId: number; title: string }): Promise<void> => {}),
    readProjectTasks: jest.fn(async () => tasks),
  }
}

describe('project handoff mention fixture preparation', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('waits for every late completion and the whole precision barrier before touching once', async () => {
    const input = fixture()
    const completions = input.taskIds.map(() => deferred())
    input.waitForCompleted.mockImplementation(taskId => {
      return completions[input.taskIds.indexOf(taskId)].promise
    })
    const preparing = prepareProjectMentionTasks(input)

    expect(input.waitForCompleted.mock.calls).toEqual([[421]])
    completions[0].resolve()
    await Promise.resolve()
    expect(input.waitForCompleted.mock.calls).toEqual([[421], [423]])
    await jest.advanceTimersByTimeAsync(2_000)
    expect(input.touchTask).not.toHaveBeenCalled()
    expect(input.readProjectTasks).not.toHaveBeenCalled()

    completions[1].resolve()
    await Promise.resolve()
    expect(input.waitForCompleted.mock.calls).toEqual([[421], [423], [425]])
    await jest.advanceTimersByTimeAsync(2_000)
    expect(input.touchTask).not.toHaveBeenCalled()

    completions[2].resolve()
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(1_099)
    expect(input.touchTask).not.toHaveBeenCalled()
    expect(input.readProjectTasks).not.toHaveBeenCalled()

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
    input.tasks[2].updated_at = '2026-10-28T05:01:39.900Z'
    const preparing = prepareProjectMentionTasks(input)

    await jest.runAllTimersAsync()
    await preparing

    expect(input.waitForCompleted.mock.calls).toEqual([[421], [423], [425]])
    expect(input.touchTask.mock.calls).toEqual(input.visibleTasks.map(task => [task]))
    expect(input.readProjectTasks).toHaveBeenCalledTimes(1)
  })

  it.each<[string, (tasks: ProjectTask[]) => void, RegExp]>([
    [
      'a target and a filler tied at second precision despite different milliseconds',
      tasks => {
        tasks[0].updated_at = '2026-10-28T05:01:38.999Z'
        tasks[2].updated_at = '2026-10-28T05:01:38.001Z'
      },
      /must sort ahead of every filler/,
    ],
    [
      'an older target',
      tasks => {
        tasks[0].updated_at = '2026-10-28T05:01:36.000Z'
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
    input.readProjectTasks.mockImplementation(async () => {
      damage(input.tasks)
      return input.tasks
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

  it('propagates a completion failure before starting the precision barrier or touches', async () => {
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
