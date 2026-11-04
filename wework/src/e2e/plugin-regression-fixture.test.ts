// @vitest-environment node

import { expect, test, vi } from 'vitest'
import {
  assertInstallButton,
  completedApiResourceTimings,
} from '../../e2e/desktop/modules/plugin-regression-fixture.mjs'

test('checks the enabled install label before reconciliation can replace the button', async () => {
  const command = vi.fn(async (action: string) => {
    // A later command sees the disabled button excluded by the selector.
    return action === 'waitFor' ? '安装' : ''
  })
  await expect(assertInstallButton({ command }, { pluginId: 101 })).resolves.toBeUndefined()
})

test('rejects an enabled control that is not an install action', async () => {
  const command = vi.fn(async () => '正在安装')
  await expect(assertInstallButton({ command }, { pluginId: 101 })).rejects.toThrow()
})

test('identifies the released old API read using the renderer clock, excluding other resources', async () => {
  const command = vi.fn(async () =>
    JSON.stringify({
      timeOrigin: 10_000,
      network: [
        { path: '/api/plugins/installed', initiatorType: 'fetch', startTime: 100, duration: 500 },
        { path: '/api/plugins/installed', initiatorType: 'fetch', startTime: 200, duration: 50 },
        { path: '/api/other', initiatorType: 'fetch', startTime: 100, duration: 500 },
        { path: '/api/plugins/installed', initiatorType: 'img', startTime: 100, duration: 500 },
      ],
    })
  )
  const timings = await completedApiResourceTimings({ command }, '/api/plugins/installed')
  const releasedAt = 10_400
  expect(timings.filter(timing => timing.completedAt >= releasedAt)).toEqual([
    {
      path: '/api/plugins/installed',
      startedAt: 10_100,
      completedAt: 10_600,
      durationMs: 500,
    },
  ])
  expect(command).toHaveBeenCalledWith('getWorkbenchDebugSnapshot', 'body')
})

test('rejects snapshot timings without a renderer clock instead of accepting ambiguous evidence', async () => {
  const command = vi.fn(async () => JSON.stringify({ network: [] }))
  await expect(completedApiResourceTimings({ command }, '/api/plugins/installed')).rejects.toThrow(
    'Missing renderer performance time origin'
  )
})

test('correlates coalesced fetch consumers with the held response instead of an unrelated slow read', async () => {
  const resources = [
    { startTime: 100, duration: 500, responseId: 'held-inventory-response' },
    { startTime: 200, duration: 415, responseId: 'held-inventory-response' },
    { startTime: 150, duration: 500, responseId: 'unrelated-response' },
  ]
  const command = vi.fn(async () =>
    JSON.stringify({
      timeOrigin: 10_000,
      network: resources.map(({ startTime, duration, responseId }) => ({
        path: '/api/plugins/installed',
        initiatorType: 'fetch',
        startTime,
        duration,
        serverTiming: [{ name: 'wework-e2e-response', description: responseId }],
      })),
    })
  )
  const timings = await completedApiResourceTimings({ command }, '/api/plugins/installed')
  expect(timings.filter(timing => timing.responseTimingId === 'held-inventory-response')).toEqual([
    {
      path: '/api/plugins/installed',
      startedAt: 10_100,
      completedAt: 10_600,
      durationMs: 500,
      responseTimingId: 'held-inventory-response',
    },
    {
      path: '/api/plugins/installed',
      startedAt: 10_200,
      completedAt: 10_615,
      durationMs: 415,
      responseTimingId: 'held-inventory-response',
    },
  ])
})
