import { expect, test, vi } from 'vitest'
import { stopServices } from './stop-services.js'

test('reports every failed owner after attempting all shutdowns, including synchronous failures', async () => {
  const stopped: string[] = []
  let finish!: () => void
  const pending = new Promise<void>(resolve => {
    finish = resolve
  })
  const operation = stopServices([
    {
      name: 'executor',
      stop: () => {
        throw new Error('Process remains alive')
      },
    },
    {
      name: 'core',
      stop: async () => {
        await pending
        stopped.push('core')
      },
    },
    {
      name: 'workbench',
      stop: async () => {
        stopped.push('workbench')
      },
    },
  ])
  const settled = vi.fn()
  const rejection = expect(operation.finally(settled)).rejects.toMatchObject({
    message: 'Application services failed to stop',
    errors: [expect.objectContaining({ message: 'Failed to stop executor' })],
  })
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  finish()
  await rejection
  expect(stopped.sort()).toEqual(['core', 'workbench'])
})
