import '@/i18n'
import { expect, test, vi } from 'vitest'
import type { LocalExecutorStatus } from '@/desktop/localExecutor'
import * as diagnostics from '@/lib/model-loading-diagnostics'
import { createLocalAppServices } from './localServices'

test('directory diagnostics distinguish identity resolution from RPC waiting without paths', async () => {
  const log = vi.spyOn(diagnostics, 'logModelLoading').mockImplementation(() => {})
  let resolveDevice!: (status: LocalExecutorStatus) => void
  let resolveCommand!: (result: unknown) => void
  const device = new Promise<LocalExecutorStatus>(resolve => {
    resolveDevice = resolve
  })
  const response = new Promise(resolve => {
    resolveCommand = resolve
  })
  const request = vi.fn().mockReturnValue(response)
  const services = createLocalAppServices({
    available: () => device,
    request,
    subscribe: vi.fn(),
  })
  const status = { running: true, ready: true, deviceId: 'device-uuid' }
  const result = { success: true, stdout: '/private/home', stderr: '', exit_code: 0 }
  const pending = services.deviceApi.getHomeDirectory('device-uuid')
  try {
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      'directory.home_dir.resolve_device',
      expect.any(Object)
    )
    expect(request).not.toHaveBeenCalled()
    resolveDevice(status)
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      'directory.home_dir.dispatch',
      expect.any(Object)
    )
    expect(log.mock.calls.some(([, stage]) => stage.endsWith('.settled'))).toBe(false)
    resolveCommand(result)
    await expect(pending).resolves.toBe('/private/home')
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      'directory.home_dir.settled',
      expect.any(Object)
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('/private/home')
  } finally {
    resolveDevice(status)
    resolveCommand(result)
    await pending
    log.mockRestore()
  }
})
