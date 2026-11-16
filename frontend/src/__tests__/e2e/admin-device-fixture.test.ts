/** @jest-environment node */

import { spawn } from 'node:child_process'
import { startAdminDeviceFixture } from '../../../e2e/utils/admin-device-fixture'

const program = `
  const {createInterface} = require('node:readline')
  process.stderr.write('boot\\n')
  createInterface({input:process.stdin}).on('line', line => {
    const action = JSON.parse(line).action
    process.stderr.write(action + '\\n')
    console.log('admin-device-fixture:' + JSON.stringify({ok:action !== 'reject'}))
  })
`

test('sequential database actions share one process and close it after the final acknowledgement', async () => {
  const child = spawn(process.execPath, ['-e', program], { stdio: 'pipe' })
  const fixture = startAdminDeviceFixture(child)
  let diagnostics = ''
  child.stderr.on('data', chunk => {
    diagnostics += chunk
  })
  try {
    await Promise.all(
      ['expire', 'claim_execution', 'clear_execution'].map(action =>
        fixture.run({ action, record_id: 7, suffix: 'isolated' })
      )
    )
  } finally {
    await fixture.close()
  }
  expect(diagnostics.trim().split('\n')).toEqual([
    'boot',
    'expire',
    'claim_execution',
    'clear_execution',
  ])
  expect(child.exitCode).toBe(0)
})

test('a failed action or crashed fixture never becomes a successful acknowledgement', async () => {
  const child = spawn(process.execPath, ['-e', program], { stdio: 'pipe' })
  const fixture = startAdminDeviceFixture(child)
  try {
    await expect(
      fixture.run({ action: 'reject', record_id: 7, suffix: 'isolated' })
    ).rejects.toThrow('rejected')
  } finally {
    await fixture.close()
  }
  const crashed = startAdminDeviceFixture(
    spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'pipe' })
  )
  await expect(crashed.run({ action: 'expire', record_id: 7, suffix: 'isolated' })).rejects.toThrow(
    'exited 7'
  )
  await expect(crashed.close()).rejects.toThrow('exited 7')
})
