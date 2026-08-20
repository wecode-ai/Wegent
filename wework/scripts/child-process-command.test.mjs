import { describe, expect, it } from 'vitest'

import { wrapWindowsScriptCommand } from './child-process-command.mjs'

describe('wrapWindowsScriptCommand', () => {
  it('leaves native commands unchanged', () => {
    expect(
      wrapWindowsScriptCommand('tar', ['--version'], {
        platform: 'win32',
        commandInterpreter: 'cmd.exe',
      })
    ).toEqual({
      command: 'tar',
      args: ['--version'],
    })
  })

  it('leaves commands unchanged outside Windows', () => {
    expect(
      wrapWindowsScriptCommand('pnpm.cmd', ['install'], {
        platform: 'darwin',
        commandInterpreter: 'cmd.exe',
      })
    ).toEqual({
      command: 'pnpm.cmd',
      args: ['install'],
    })
  })

  it('runs Windows command scripts through the command interpreter', () => {
    expect(
      wrapWindowsScriptCommand('pnpm.CMD', ['install', '--prod'], {
        platform: 'win32',
        commandInterpreter: 'C:\\Windows\\System32\\cmd.exe',
      })
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'pnpm.CMD', 'install', '--prod'],
    })
  })
})
