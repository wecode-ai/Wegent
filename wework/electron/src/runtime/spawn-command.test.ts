import { describe, expect, test } from 'vitest'

import { resolveSpawnCommand } from './spawn-command.js'

describe('resolveSpawnCommand', () => {
  test('leaves native commands unchanged', () => {
    expect(resolveSpawnCommand('wegent-executor', ['serve'], 'win32', 'cmd.exe')).toEqual({
      command: 'wegent-executor',
      args: ['serve'],
    })
  })

  test('leaves commands unchanged outside Windows', () => {
    expect(resolveSpawnCommand('executor.cmd', ['serve'], 'darwin', 'cmd.exe')).toEqual({
      command: 'executor.cmd',
      args: ['serve'],
    })
  })

  test('runs Windows command scripts through the command interpreter', () => {
    expect(
      resolveSpawnCommand(
        'dev-executor-sidecar.CMD',
        ['browser-mcp-server'],
        'win32',
        'C:\\Windows\\System32\\cmd.exe'
      )
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'dev-executor-sidecar.CMD', 'browser-mcp-server'],
    })
  })
})
