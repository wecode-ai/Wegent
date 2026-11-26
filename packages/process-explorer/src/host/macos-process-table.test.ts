import { basename } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MacosProcessTable, parsePsLine } from './macos-process-table'
import { resolveProcessName } from './process-name'

const STARTED = 'Thu Nov 12 01:34:32 2026'

/** Mirrors the column widths of `ps -axo pid=,ppid=,pcpu=,rss=,lstart=,ucomm=,args=`. */
function psLine(pid: number, ppid: number, ucomm: string, args: string, cpu = '0.0', rss = 24208) {
  const started = STARTED.padEnd(28)
  return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${cpu.padStart(4)} ${String(rss).padStart(6)} ${started}${ucomm.padEnd(16)} ${args}`
}

describe('resolveProcessName', () => {
  it.each([
    // systeminformation split these at the first " -" or " /".
    ['gh api --include --hostname github.com --method GET repos/x/y?state=all', 'gh', 'gh'],
    ['git fetch fork https://github.com/sleepdrop/Wegent.git', 'git', 'git'],
    // ... and took the tail of the last URL when there was nothing to split at.
    [
      '/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core/git-remote-https fork https://github.com/sleepdrop/Wegent.git',
      'git-remote-https',
      'git-remote-https',
    ],
    // Executable paths with spaces resolve at the real boundary.
    [
      '/Applications/Weibo WeWork.app/Contents/Frameworks/Weibo WeWork Helper.app/Contents/MacOS/Weibo WeWork Helper --type=utility',
      'Weibo WeWork Hel',
      'Weibo WeWork Helper',
    ],
    // Names longer than 16 characters are restored from the command line.
    ['/Users/x/bin/codex-code-mode-host --stdio', 'codex-code-mode-', 'codex-code-mode-host'],
    ['/bin/sh -c "git fetch fork"', 'sh', 'sh'],
    // No arguments follow a path with spaces; the whole line is the candidate.
    ['/tmp/Weibo WeWork Helper', 'Weibo WeWork Hel', 'Weibo WeWork Helper'],
    // Linux comm is 15 bytes, not 15 characters.
    ['/tmp/工具工具工具-extra --flag', '工具工具工', '工具工具工具-extra'],
    ['bash -c ls -la', 'bash', 'bash'],
    ['git', 'git', 'git'],
    ['[bash]', 'bash', 'bash'],
    ['', 'launchd', 'launchd'],
    // argv[0] was rewritten by the caller; only the kernel name is known.
    ['renamed-tool --serve', 'git', 'git'],
  ])('%s', (args, ucomm, expected) => {
    expect(resolveProcessName(args, ucomm)).toBe(expected)
  })
})

describe('MacosProcessTable', () => {
  it('parses columns and keeps the command line intact', () => {
    const startedAt = new Date(2026, 10, 12, 1, 34, 32).getTime()
    expect(
      parsePsLine(
        psLine(
          7383,
          7375,
          'Weibo WeWork Hel',
          '/Applications/Weibo WeWork Helper --type=gpu',
          '16.0'
        )
      )
    ).toEqual({
      pid: 7383,
      parentPid: 7375,
      name: 'Weibo WeWork Helper',
      command: '/Applications/Weibo WeWork Helper --type=gpu',
      cpuPercent: 16,
      memoryBytes: 24208 * 1024,
      startedAt,
      identity: STARTED,
    })
  })

  it('accepts single-digit days and rejects lines in another format', () => {
    expect(
      parsePsLine(psLine(1, 0, 'launchd', '/sbin/launchd').replace('Nov 12', 'Nov  2'))
    ).toMatchObject({
      pid: 1,
      name: 'launchd',
    })
    expect(parsePsLine('garbage')).toBeNull()
  })

  it('hides its own ps process and skips an unparseable line', async () => {
    const readPs = vi.fn(async () => ({
      pid: 99,
      output: [
        psLine(99, 1, 'ps', 'ps -axo pid='),
        psLine(2, 1, 'launchd', '/sbin/launchd'),
        '',
        'not a ps line',
      ].join('\n'),
    }))
    const result = await new MacosProcessTable(readPs).read()
    expect(result.processes.map(row => row.pid)).toEqual([2])
    expect(result.degraded).toEqual([])
  })

  it('reports a failed read only when no line parses', async () => {
    const result = await new MacosProcessTable(async () => ({
      pid: 99,
      output: ['not a ps line', ''].join('\n'),
    })).read()
    expect(result.degraded).toEqual([
      { code: 'system-process-table-failed', detail: '1 ps line could not be parsed' },
    ])
  })

  it('finds the ucomm boundary in bytes and keeps a multi-byte command line', () => {
    // `ps` truncates ucomm to 16 bytes, here in the middle of the 6th character.
    const header = Buffer.from(`    7383   7375  0.0  24208 ${STARTED}    `)
    const line = Buffer.concat([
      header,
      Buffer.from('睡眠程序测试').subarray(0, 16),
      Buffer.from(' /tmp/睡眠程序测试 --flag'),
    ]).toString('latin1')
    expect(parsePsLine(line)).toMatchObject({
      pid: 7383,
      name: '睡眠程序测试',
      command: '/tmp/睡眠程序测试 --flag',
    })
  })

  it('reports a failed ps invocation as degradation', async () => {
    const result = await new MacosProcessTable(async () => {
      throw new Error('ps exited with code 1')
    }).read()
    expect(result.processes).toEqual([])
    expect(result.degraded).toEqual([
      { code: 'system-process-table-failed', detail: 'ps exited with code 1' },
    ])
  })

  // Runs against the real `ps` output wherever the suite executes on macOS.
  it.skipIf(process.platform !== 'darwin')('parses the live macOS table', async () => {
    const result = await new MacosProcessTable().read()
    expect(result.degraded).toEqual([])
    expect(result.processes.find(row => row.pid === process.pid)?.name).toBe(
      basename(process.execPath)
    )
  })
})
