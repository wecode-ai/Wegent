import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { PythonRuntimeLoginRequiredError } from './python-runtime-downloads.js'
import { PythonRuntimeManager } from './python-runtime.js'

test('late demand reads cannot restart a failed login preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'python-login-demand-'))
  try {
    const slow = Promise.withResolvers<boolean>()
    const demand = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(true)
    const downloads = vi
      .fn()
      .mockRejectedValueOnce(new PythonRuntimeLoginRequiredError())
      .mockRejectedValue(new Error('configuration failed'))
    const runtime = new PythonRuntimeManager({
      dataDirectory: root,
      environment: {},
      resolveDownloads: downloads,
      hasPluginDemand: demand,
    })
    await runtime.prewarm()
    const earlierLogin = runtime.resumeAfterLogin()
    await vi.waitFor(() => expect(demand).toHaveBeenCalledOnce())
    await expect(runtime.resumeAfterLogin()).rejects.toThrow('configuration failed')
    slow.resolve(true)
    await expect(earlierLogin).resolves.toMatchObject({ state: 'error' })
    await runtime.resumeAfterLogin()
    await runtime.prewarm()
    expect(downloads).toHaveBeenCalledTimes(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed demand read cannot download or consume a later real login event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'python-login-demand-'))
  try {
    const demand = vi
      .fn()
      .mockRejectedValueOnce(new Error('inventory unavailable'))
      .mockResolvedValue(false)
    const downloads = vi.fn().mockRejectedValue(new PythonRuntimeLoginRequiredError())
    const runtime = new PythonRuntimeManager({
      dataDirectory: root,
      environment: {},
      resolveDownloads: downloads,
      hasPluginDemand: demand,
    })
    await runtime.prewarm()
    await expect(runtime.resumeAfterLogin()).rejects.toThrow('inventory unavailable')
    await expect(runtime.resumeAfterLogin()).resolves.toMatchObject({ state: 'notInstalled' })
    expect(demand).toHaveBeenCalledTimes(2)
    expect(downloads).toHaveBeenCalledOnce()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
