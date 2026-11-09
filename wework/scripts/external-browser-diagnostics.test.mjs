// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { sampleBrowserProcesses } from '../e2e/desktop/modules/external-browser-diagnostics.mjs'

test('startup sampling follows only the driver descendants and retains thread wait evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-proc-test-'))
  try {
    for (const [pid, children] of [
      ['100', '101'],
      ['101', ''],
      ['200', ''],
    ]) {
      const task = join(root, pid, 'task', pid)
      await mkdir(task, { recursive: true })
      await Promise.all(
        Object.entries({
          comm: 'chrome',
          wchan: 'futex_wait',
          schedstat: '100 200 3',
          children,
        }).map(([file, value]) => writeFile(join(task, file), value))
      )
      await writeFile(join(root, pid, 'status'), 'State: S (sleeping)')
    }
    const processes = await sampleBrowserProcesses(100, root)
    expect(processes.map(process => process.pid)).toEqual(['100', '101'])
    expect(processes[1].threads).toEqual([
      { tid: '101', name: 'chrome', waitChannel: 'futex_wait', scheduling: '100 200 3' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a process exiting during startup sampling retains missing-process evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-proc-test-'))
  try {
    expect(await sampleBrowserProcesses(100, root)).toEqual([
      {
        pid: '100',
        status: '<ENOENT>',
        faults: { unavailable: '<ENOENT>' },
        fileIO: '<ENOENT>',
        threads: [],
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file-page waits retain fault counters, I/O, kernel stack and the instruction mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-proc-test-'))
  try {
    const process = join(root, '100')
    const task = join(process, 'task', '100')
    await mkdir(task, { recursive: true })
    const fields = Array(40).fill('0')
    fields[0] = 'D'
    fields[7] = '123'
    fields[9] = '45'
    const files = {
      [join(task, 'comm')]: 'chrome',
      [join(task, 'wchan')]: 'folio_wait_bit_common',
      [join(task, 'schedstat')]: '200 30 4',
      [join(task, 'children')]: '',
      [join(task, 'stack')]: 'filemap_fault -> folio_wait_bit_common',
      [join(task, 'syscall')]: '-1 0xabcd 0x1234',
      [join(process, 'maps')]: '1000-2000 r-xp 00000000 00:01 10 /opt/google/chrome/chrome\n',
      [join(process, 'stat')]: `100 (chrome (with spaces)) ${fields.join(' ')}`,
      [join(process, 'status')]: 'State: D (disk sleep)',
      [join(process, 'io')]: 'read_bytes: 8192\nwrite_bytes: 4096\n',
    }
    await Promise.all(Object.entries(files).map(([path, value]) => writeFile(path, value)))
    const [sample] = await sampleBrowserProcesses(100, root)
    expect(sample.faults).toEqual({ minor: 123, major: 45 })
    expect(sample.fileIO).toBe(files[join(process, 'io')])
    expect(sample.threads[0].diskWait).toEqual({
      kernelStack: 'filemap_fault -> folio_wait_bit_common',
      systemCall: '-1 0xabcd 0x1234',
      instructionFile: '/opt/google/chrome/chrome',
    })
    await rm(join(task, 'stack'))
    await rm(join(task, 'syscall'))
    const [missing] = await sampleBrowserProcesses(100, root)
    expect(missing.threads[0].diskWait).toEqual({
      kernelStack: '<ENOENT>',
      systemCall: '<ENOENT>',
      instructionFile: null,
    })
    expect(missing.faults).toEqual({ minor: 123, major: 45 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
