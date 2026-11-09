import { join } from 'node:path'
import { expect, test } from 'vitest'
import { serializePathOperation } from './path-operation-queue.js'

test('serializes equivalent paths, preserves results and allows unrelated paths to run', async () => {
  const path = join(process.cwd(), 'runtime-catalog')
  const events: string[] = []
  let release!: () => void
  const blocked = new Promise<void>(accept => {
    release = accept
  })
  const first = serializePathOperation(path, async () => {
    events.push('first-start')
    await blocked
    events.push('first-end')
    return 'first'
  })
  const second = serializePathOperation(join(path, 'nested', '..'), async () => {
    events.push('second')
    return 'second'
  })
  await serializePathOperation(`${path}-other`, async () => {
    events.push('other')
  })
  expect(events).toEqual(['first-start', 'other'])
  release()
  expect(await Promise.all([first, second])).toEqual(['first', 'second'])
  expect(events).toEqual(['first-start', 'other', 'first-end', 'second'])
})

test('reports a failed write without retrying or poisoning later queued writes', async () => {
  const path = join(process.cwd(), 'failed-runtime-catalog')
  const failure = new Error('write failed')
  let attempts = 0
  const first = serializePathOperation(path, async () => {
    attempts++
    throw failure
  })
  const second = serializePathOperation(path, async () => {
    attempts++
    return 'independent write'
  })
  await expect(first).rejects.toBe(failure)
  expect(await second).toBe('independent write')
  expect(attempts).toBe(2)
})
