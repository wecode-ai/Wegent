import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopRendererStorage } from './desktop-renderer-storage.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
const connection = JSON.stringify({
  apiBaseUrl: 'https://cloud.example/api',
  user: { id: 1 },
  credentialMode: 'desktop_refresh',
})

async function fixture({ enabled = true, shuttingDown = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-login-storage-'))
  directories.push(directory)
  const resume = vi.fn(async () => undefined)
  const developmentResume = vi.fn(async () => undefined)
  const python = vi.fn(() => Promise.resolve({ resumeAfterLogin: resume }))
  const development = vi.fn(() => ({ resumePythonAfterLogin: developmentResume }))
  const storage = createDesktopRendererStorage(directory, {
    enabled,
    isShuttingDown: () => shuttingDown,
    python,
    development,
  })
  return { storage, resume, developmentResume, python, development }
}

test.each([
  null,
  '',
  '{}',
  'not-json',
  JSON.stringify({ apiBaseUrl: 'file:///tmp/api', user: { id: 1 } }),
])('ignores logout or invalid login state: %s', async value => {
  const current = await fixture()
  await current.storage.update({ clear: false, changes: { 'wework.cloudConnection': value } })
  expect(current.python).not.toHaveBeenCalled()
  expect(current.development).not.toHaveBeenCalled()
})
test.each([{ enabled: false }, { shuttingDown: true }])(
  'does not resume disabled or closing hosts: %j',
  async options => {
    const current = await fixture(options)
    await current.storage.update({
      clear: false,
      changes: { 'wework.cloudConnection': connection },
    })
    expect(current.python).not.toHaveBeenCalled()
    expect(current.development).not.toHaveBeenCalled()
  }
)
test('unrelated storage changes do not create runtime instances', async () => {
  const current = await fixture()
  await current.storage.initialize({ appearance: 'dark' })
  await current.storage.update({ clear: false, changes: { appearance: 'light' } })
  expect(current.python).not.toHaveBeenCalled()
  expect(current.development).not.toHaveBeenCalled()
})
test('parent failure cannot block child recovery or reject the committed storage write', async () => {
  const current = await fixture()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  current.resume.mockRejectedValue(new Error('preparation failed'))
  await expect(
    current.storage.update({ clear: false, changes: { 'wework.cloudConnection': connection } })
  ).resolves.toBeUndefined()
  await vi.waitFor(() =>
    expect(console.warn).toHaveBeenCalledWith('[python-runtime] Login-triggered preparation failed')
  )
  expect(current.developmentResume).toHaveBeenCalledOnce()
  expect(JSON.parse((await current.storage.read())['wework.cloudConnection'])).toHaveProperty(
    'user.id',
    1
  )
})
test('login does not instantiate missing managers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-login-storage-'))
  directories.push(directory)
  const storage = createDesktopRendererStorage(directory, {
    enabled: true,
    isShuttingDown: () => false,
    python: () => null,
    development: () => null,
  })
  await expect(
    storage.update({ clear: false, changes: { 'wework.cloudConnection': connection } })
  ).resolves.toBeUndefined()
})

test('recovery can read committed login state without blocking the storage queue', async () => {
  const current = await fixture()
  const observed = Promise.withResolvers<Record<string, string>>()
  current.resume.mockImplementation(async () => {
    observed.resolve(await current.storage.read())
  })
  await current.storage.update({ clear: false, changes: { 'wework.cloudConnection': connection } })
  expect((await observed.promise)['wework.cloudConnection']).toBe(connection)
})
