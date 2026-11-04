// @vitest-environment node

import { afterEach, expect, test, vi } from 'vitest'
import { nativeCloudAuthorizationFixture } from '../e2e/desktop/modules/native-cloud-authorization-client.mjs'

const transport = vi.hoisted(() => ({ calls: [], failure: null, output: null }))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal()),
  execFile(binary, args, options, callback) {
    return {
      stdin: {
        end(input) {
          const body = JSON.parse(input)
          transport.calls.push({ binary, args, options, body })
          queueMicrotask(() =>
            callback(
              body.clear ? null : transport.failure,
              transport.output ?? (body.clear ? 'cleared' : 'authorized')
            )
          )
        },
      },
    }
  },
}))

const cloud = { backendUrl: 'http://127.0.0.1:8000', authToken: 'synthetic-user-token' }
const binary = '/fixture/shared-packaged-electron'

afterEach(() => {
  transport.calls = []
  transport.failure = null
  transport.output = null
})

test('real native login and cleanup use the same isolated profile and opaque snapshot', async () => {
  const fixture = nativeCloudAuthorizationFixture(cloud, '/fixture/profile', binary)
  await fixture.authorize()
  await fixture.restore()
  expect(transport.calls).toHaveLength(2)
  const [login, cleanup] = transport.calls
  expect(login.binary).toBe(binary)
  expect(login.args).toHaveLength(1)
  expect(login.args[0]).toMatch(/native-cloud-authorization\.mjs$/)
  expect(login.options.timeout).toBe(10_000)
  expect(login.options.env.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(login.body).toEqual({
    apiBaseUrl: `${cloud.backendUrl}/api`,
    authToken: cloud.authToken,
    userDataDirectory: '/fixture/profile',
    snapshotId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    clear: false,
  })
  expect(cleanup.body).toEqual({ ...login.body, clear: true })
  expect(JSON.stringify([login.args, login.options])).not.toContain(cloud.authToken)
})

test('cleanup remains available after a partially failed authorization', async () => {
  const fixture = nativeCloudAuthorizationFixture(cloud, '/fixture/profile', binary)
  transport.failure = new Error('Native session could not be claimed')
  await expect(fixture.authorize()).rejects.toThrow('Native session could not be claimed')
  await fixture.restore()
  expect(transport.calls.map(call => call.body.clear)).toEqual([false, true])
  expect(transport.calls[1].body.snapshotId).toBe(transport.calls[0].body.snapshotId)
})

test('an invalid acknowledgement fails without exposing subprocess output', async () => {
  transport.output = `invalid-${cloud.authToken}`
  const fixture = nativeCloudAuthorizationFixture(cloud, '/fixture/profile', binary)
  await expect(fixture.authorize()).rejects.toThrow('Native cloud authorization did not complete')
})

test("concurrent scenario fixtures cannot restore each other's native credentials", async () => {
  const first = nativeCloudAuthorizationFixture(cloud, '/fixture/first', binary)
  const second = nativeCloudAuthorizationFixture(cloud, '/fixture/second', binary)
  await Promise.all([first.authorize(), second.authorize()])
  expect(transport.calls[0].body.snapshotId).not.toBe(transport.calls[1].body.snapshotId)
  await first.restore()
  expect(transport.calls[2].body.userDataDirectory).toBe('/fixture/first')
  expect(transport.calls[2].body.snapshotId).toBe(transport.calls[0].body.snapshotId)
})
