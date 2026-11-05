import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { RuntimeDiagnosticsLog } from './runtime-diagnostics-log.js'

test('persists task diagnostics from separate renderer surfaces without recording other console output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-runtime-log-'))
  try {
    const path = join(directory, 'runtime-launch.log')
    const log = new RuntimeDiagnosticsLog(path)
    await log.record(1, 'unrelated console output')
    await log.record(
      2,
      '[Wework] Runtime task create diagnostic {"stage":"pane-waiting-state","taskId":"runtime-1","waiting":false}'
    )
    await log.record(
      3,
      '[Wework] Runtime task create diagnostic {"stage":"lifecycle-transition","taskId":"runtime-1"}'
    )
    const contents = await readFile(path, 'utf8')
    expect(contents).toContain('web_contents_id=2')
    expect(contents).toContain('web_contents_id=3')
    expect(contents).toContain('"waiting":false')
    expect(contents).not.toContain('unrelated console output')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('persists executor transport diagnostics with the configured prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-transport-log-'))
  try {
    const path = join(directory, 'executor-transport.log')
    const prefix = '[Wework] Executor transport diagnostic '
    const log = new RuntimeDiagnosticsLog(path, prefix)
    await log.record(2, prefix + JSON.stringify({ requestId: 'rpc-1', stage: 'fetch_failed' }))
    await log.record(2, 'unrelated console output')
    expect(await readFile(path, 'utf8')).toContain('"requestId":"rpc-1"')
    expect(await readFile(path, 'utf8')).not.toContain('unrelated console output')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('persists interaction failure context and redacts credentials in exception details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-interaction-log-'))
  try {
    const path = join(directory, 'runtime-launch.log')
    const log = new RuntimeDiagnosticsLog(path)
    await log.record(
      1,
      '[Wework] Runtime task create diagnostic ' +
        JSON.stringify({
          stage: 'pending-interaction-load-failed',
          operation: 'transcript',
          deviceId: 'device-1',
          taskId: 'task-1',
          error: { message: 'HTTP 401 token=private-value', stack: 'Error: token=private-value' },
        })
    )
    await log.flush()
    const contents = await readFile(path, 'utf8')
    expect(contents).toContain('"stage":"pending-interaction-load-failed"')
    expect(contents).toContain('"operation":"transcript"')
    expect(contents).toContain('"deviceId":"device-1"')
    expect(contents).toContain('"taskId":"task-1"')
    expect(contents).toContain('HTTP 401')
    expect(contents).not.toContain('private-value')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('persists local catalog lifecycle messages without unrelated renderer output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-local-catalog-log-'))
  try {
    const path = join(directory, 'local-workspace-catalog.log')
    const prefix = '[Wework] Local workspace catalog '
    const log = new RuntimeDiagnosticsLog(path, prefix)
    for (const status of ['started', 'fulfilled', 'rejected']) {
      const diagnostic = JSON.stringify({
        source: 'local',
        catalog: 'agents',
        status,
        elapsedMs: 1,
      })
      await log.record(3, prefix + (status === 'rejected' ? 'failed ' : '') + diagnostic)
    }
    await log.record(3, '[Wework] Local workspace unrelated console output')
    await log.flush()

    const contents = await readFile(path, 'utf8')
    expect(contents).toContain('web_contents_id=3')
    expect(contents).toContain('"catalog":"agents"')
    for (const status of ['started', 'fulfilled', 'rejected']) {
      expect(contents).toContain(`"status":"${status}"`)
    }
    expect(contents).not.toContain('unrelated console output')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
