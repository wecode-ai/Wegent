import { expect, test } from 'vitest'
import { createTaskActivityState, type TaskActivityInput } from './taskActivityState'

test('acknowledges the revision observed by the viewport before the next subscription commits', async () => {
  const task = { id: 'issue', version: 3, content_revision: 3, is_unread: true }
  let stored = {
    ...task,
    version: 5,
    content_revision: 5,
    is_unread: true,
  }
  let confirmedRead = false
  const markLoopItemRead = async (...args: [string, number | undefined, number | undefined]) => {
    if ((args[2] ?? 0) >= stored.content_revision) stored = { ...stored, is_unread: false }
    return stored
  }
  const api = { markLoopItemRead } as unknown as Parameters<typeof createTaskActivityState>[1]
  const source = createTaskActivityState(undefined, api, undefined, 'project', 'issue')
  const stop = source.subscribe(() => {}, {
    task,
    bindings: [],
    devices: [],
    notification: null,
    store: 'local',
    t: (key: string) => key,
    onTaskRead: updated => {
      confirmedRead = updated.is_unread === false
    },
  } as TaskActivityInput)
  try {
    await source.markRead(0, 5)
    expect(stored.is_unread).toBe(false)
    expect(confirmedRead).toBe(true)
  } finally {
    stop()
  }
})
