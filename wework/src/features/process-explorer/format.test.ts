import { describe, expect, it } from 'vitest'
import {
  formatAge,
  formatCpu,
  formatMemory,
  normalizeLaunchDetail,
  splitLaunchDetail,
} from './format'

describe('process explorer formatting', () => {
  it('formats byte counts', () => {
    expect(formatMemory(null)).toBe('—')
    expect(formatMemory(512)).toBe('512 B')
    expect(formatMemory(2048)).toBe('2.0 KB')
    expect(formatMemory(2 * 1024 ** 2)).toBe('2.0 MB')
    expect(formatMemory(2 * 1024 ** 3)).toBe('2.0 GB')
  })

  it('formats CPU and unknown values', () => {
    expect(formatCpu(null)).toBe('—')
    expect(formatCpu(12.34)).toBe('12.3')
    expect(formatCpu(0)).toBe('0.0')
  })

  it('formats process age', () => {
    const now = 1_000_000_000
    expect(formatAge(null, now)).toBe('—')
    expect(formatAge(now - 30_000, now)).toBe('30s')
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m')
    expect(formatAge(now - (2 * 3600 + 5 * 60) * 1000, now)).toBe('2h 5m')
    expect(formatAge(now - (3 * 86_400 + 4 * 3600) * 1000, now)).toBe('3d 4h')
  })

  it('removes the Windows object-manager prefix from launch details', () => {
    expect(normalizeLaunchDetail('\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4')).toBe(
      'C:\\WINDOWS\\system32\\conhost.exe 0x4'
    )
  })

  it('splits Windows executable paths from their arguments', () => {
    expect(splitLaunchDetail('\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4', 'win32')).toEqual({
      command: 'C:\\WINDOWS\\system32\\conhost.exe',
      args: '0x4',
    })
    expect(splitLaunchDetail('"C:\\Program Files\\App\\app.exe" --flag value', 'win32')).toEqual({
      command: 'C:\\Program Files\\App\\app.exe',
      args: '--flag value',
    })
  })

  it('keeps macOS launch details intact because paths may contain spaces', () => {
    const detail = '/Applications/WeWork Helper.app/Contents/MacOS/WeWork Helper --type=renderer'
    expect(splitLaunchDetail(detail, 'darwin')).toEqual({ command: detail, args: null })
  })
})
