import { expect, test, vi } from 'vitest'

import { runStartupStage } from './startup-stage.js'

test('reports completed startup stages with result details', async () => {
  const report = vi.fn()

  await expect(
    runStartupStage(
      report,
      'profile-copy',
      async () => 3,
      count => ({ count })
    )
  ).resolves.toBe(3)

  expect(report.mock.calls.map(([event]) => event)).toEqual([
    expect.objectContaining({ stage: 'profile-copy', phase: 'started' }),
    expect.objectContaining({
      stage: 'profile-copy',
      phase: 'completed',
      details: { count: 3 },
    }),
  ])
})

test('reports a failed startup stage and preserves the error', async () => {
  const report = vi.fn()
  const failure = new Error('copy failed')

  await expect(
    runStartupStage(report, 'profile-copy', async () => {
      throw failure
    })
  ).rejects.toBe(failure)

  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({ stage: 'profile-copy', phase: 'failed' })
  )
})
