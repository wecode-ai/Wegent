/** @jest-environment node */
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from 'node:child_process'
import { withAdminDeviceState } from '../../../e2e/fixtures/admin-device-state'

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: jest.fn(),
}))

const realSpawn =
  jest.requireActual<typeof import('node:child_process')>('node:child_process').spawn
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>
const server = `
  const { createInterface } = require('node:readline')
  console.log('Fixture initialized')
  createInterface({ input: process.stdin }).on('line', line => {
    JSON.parse(line)
    console.log('ADMIN_DEVICE_STATE ' + JSON.stringify({ success: true }))
  })
`

beforeEach(() => {
  jest.clearAllMocks()
  mockSpawn.mockImplementation((_command, _args, options) =>
    realSpawn(process.execPath, ['-e', server], options)
  )
})

function expectStopped() {
  const child = mockSpawn.mock.results[0].value as ChildProcess
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
}

it('uses one owned process for sequential fixture actions and closes it afterward', async () => {
  await withAdminDeviceState(async apply => {
    for (const action of ['expire', 'claim_execution', 'clear_execution', 'expire'] as const) {
      await apply({ action, record_id: 42, suffix: 'fixture-owner' })
    }
  })

  expect(mockSpawn).toHaveBeenCalledTimes(1)
  expect(mockSpawn.mock.calls[0][0]).toBe('uv')
  expect(mockSpawn.mock.calls[0][1]).toEqual([
    'run',
    '--no-sync',
    'python',
    '-m',
    'tests.e2e_admin_device_fixture',
  ])
  expectStopped()
})

it('propagates an unsuccessful acknowledgment and still closes the process', async () => {
  mockSpawn.mockImplementation((_command, _args, options) =>
    realSpawn(process.execPath, ['-e', server.replace('success: true', 'success: false')], options)
  )

  await expect(
    withAdminDeviceState(apply =>
      apply({ action: 'expire', record_id: 42, suffix: 'fixture-owner' })
    )
  ).rejects.toThrow()
  expectStopped()
})

it('fails when the process exits without acknowledging an action', async () => {
  mockSpawn.mockImplementation((_command, _args, options) =>
    realSpawn(process.execPath, ['-e', 'process.exit(23)'], options)
  )

  await expect(
    withAdminDeviceState(apply =>
      apply({ action: 'expire', record_id: 42, suffix: 'fixture-owner' })
    )
  ).rejects.toThrow('Device state fixture closed before acknowledging')
  expectStopped()
})
