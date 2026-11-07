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
      { pid: '100', status: '<ENOENT>', threads: [] },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
