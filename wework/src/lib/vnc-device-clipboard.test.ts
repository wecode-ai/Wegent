import { describe, expect, test, vi } from 'vitest'

import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createVncDeviceClipboardBridge } from './vnc-device-clipboard'

describe('VNC device clipboard bridge', () => {
  test('round-trips UTF-8 clipboard text through fixed device commands', async () => {
    const text = 'ASCII 中文 😀\nsecond\tline'
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: encoded, stderr: '' })
    const deviceApi = { executeCommand } as unknown as WorkbenchServices['deviceApi']
    const bridge = createVncDeviceClipboardBridge(deviceApi, 'cloud-device')

    await bridge.writeText(text)
    await expect(bridge.readText()).resolves.toBe(text)

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'cloud-device', {
      command_key: 'vnc_clipboard_write',
      env: { WEWORK_VNC_CLIPBOARD_BASE64: encoded },
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'cloud-device', {
      command_key: 'vnc_clipboard_read',
      timeout_seconds: 10,
      max_output_bytes: 1398120,
    })
  })

  test('fails closed when the device command reports an error', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'clipboard unavailable',
    })
    const deviceApi = { executeCommand } as unknown as WorkbenchServices['deviceApi']
    const bridge = createVncDeviceClipboardBridge(deviceApi, 'cloud-device')

    await expect(bridge.writeText('text')).rejects.toThrow('clipboard unavailable')
  })
})
