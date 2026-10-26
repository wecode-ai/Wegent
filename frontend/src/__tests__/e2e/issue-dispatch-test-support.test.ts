// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Page } from '@playwright/test'
import { resolveConfiguredAppDeviceId } from '../../../e2e/utils/issue-dispatch-test-support'

const mockExpect = expect
jest.mock('@playwright/test', () => ({
  expect: (value: unknown) => mockExpect(value),
}))

jest.mock('../../../e2e/config/test-users', () => ({
  ADMIN_USER: { username: 'admin', password: 'test-password' },
}))

const configuredDeviceId = 'executor-app'
const appDevice = {
  id: 58,
  device_id: configuredDeviceId,
  device_type: 'app',
  execution_target_id: 'app-record-58',
}
const localDevice = {
  id: 59,
  device_id: 'compaction-executor',
  device_type: 'local',
  execution_target_id: 'compaction-executor',
}

function pageWithDevices(items: unknown[]) {
  return {
    evaluate: jest.fn().mockResolvedValue({ items }),
  } as unknown as Page
}

describe('configured Issue dispatch App device', () => {
  const originalDeviceId = process.env.E2E_DEVICE_ID

  beforeEach(() => {
    process.env.E2E_DEVICE_ID = configuredDeviceId
  })

  afterEach(() => {
    if (originalDeviceId === undefined) delete process.env.E2E_DEVICE_ID
    else process.env.E2E_DEVICE_ID = originalDeviceId
  })

  it('selects the configured App record when a local device is listed first', async () => {
    const page = pageWithDevices([localDevice, appDevice])

    await expect(resolveConfiguredAppDeviceId(page)).resolves.toBe(58)
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      requestPath: '/api/devices',
      requestInit: {},
    })
  })

  it.each([
    ['missing', [localDevice]],
    ['duplicated', [appDevice, { ...appDevice, id: 60 }]],
    ['registered as local', [{ ...localDevice, device_id: configuredDeviceId }]],
    ['missing its canonical App route', [{ ...appDevice, execution_target_id: null }]],
  ])('fails when the configured App device is %s', async (_reason, items) => {
    await expect(resolveConfiguredAppDeviceId(pageWithDevices(items))).rejects.toThrow()
  })

  it('preserves the generic fixture when no device is configured', async () => {
    delete process.env.E2E_DEVICE_ID
    const page = pageWithDevices([localDevice])

    await expect(resolveConfiguredAppDeviceId(page)).resolves.toBeUndefined()
    expect(page.evaluate).not.toHaveBeenCalled()
  })
})
