// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { test as base, expect } from '@playwright/test'
import { stopProcessGroup } from '../../../wework/e2e/desktop/process-lifecycle.mjs'

type DeviceStateRequest = {
  action: 'expire' | 'claim_execution' | 'clear_execution'
  record_id: number
  suffix: string
}

const RESULT_PREFIX = 'ADMIN_DEVICE_STATE '

type DeviceState = (request: DeviceStateRequest) => Promise<void>

export async function withAdminDeviceState(
  use: (state: DeviceState) => Promise<void>
): Promise<void> {
  const repository = resolve(__dirname, '../../..')
  const child = spawn(
    'uv',
    ['run', '--no-sync', 'python', '-m', 'tests.e2e_admin_device_fixture'],
    {
      cwd: resolve(repository, 'backend'),
      detached: true,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        PYTHONPATH: [repository, resolve(repository, 'backend')].join(delimiter),
      },
    }
  )
  const closed = new Promise<void>(accept => child.once('close', () => accept()))
  const reader = createInterface({ input: child.stdout })
  const lines = reader[Symbol.asyncIterator]()
  let failure: Error | undefined
  const fail = (error: Error) => {
    failure = error
    reader.close()
  }
  child.once('error', fail)
  child.stdin.on('error', fail)
  try {
    await use(async request => {
      if (failure) throw failure
      child.stdin.write(JSON.stringify(request) + '\n')
      const timeout = setTimeout(() => fail(new Error('Device state fixture timed out')), 30_000)
      try {
        while (true) {
          const response = await lines.next()
          if (failure) throw failure
          if (response.done) throw new Error('Device state fixture closed before acknowledging')
          if (!response.value.startsWith(RESULT_PREFIX)) continue
          expect(JSON.parse(response.value.slice(RESULT_PREFIX.length))).toEqual({ success: true })
          return
        }
      } finally {
        clearTimeout(timeout)
      }
    })
  } finally {
    reader.close()
    await stopProcessGroup(child)
    await closed
  }
}

export const test = base.extend<{ deviceState: DeviceState }>({
  deviceState: async ({}, use) => withAdminDeviceState(use),
})
