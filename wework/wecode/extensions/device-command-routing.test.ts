import { describe, expect, test } from 'vitest'
import { shouldUseCloudDeviceCommand } from './device-command-routing'

describe('VNC device command routing', () => {
  test('sends clipboard commands through the Backend', () => {
    expect(shouldUseCloudDeviceCommand('vnc_clipboard_read')).toBe(true)
    expect(shouldUseCloudDeviceCommand('vnc_clipboard_write')).toBe(true)
    expect(shouldUseCloudDeviceCommand('git_branch')).toBe(false)
  })
})
