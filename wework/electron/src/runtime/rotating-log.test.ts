import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { redactLog, RotatingLog } from './rotating-log.js'

describe('RotatingLog', () => {
  test('redacts common credentials', () => {
    expect(
      redactLog(
        'Authorization: Bearer abc.def token="secret-token" api_key=key-1 cookie=session-id'
      )
    ).toBe('Authorization: [REDACTED] token="[REDACTED]" api_key=[REDACTED] cookie=[REDACTED]')
  })

  test('rotates bounded log files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-rotating-log-'))
    const path = join(directory, 'runtime.log')
    const log = new RotatingLog({ path, maxBytes: 90, retainedFiles: 2 })

    await log.write('stdout', 'first line with enough bytes to fill the file')
    await log.write('stderr', 'second line forces rotation')
    await log.write('supervisor', 'third line forces another rotation')
    await log.flush()

    const files = (await readdir(directory)).sort()
    expect(files).toEqual(expect.arrayContaining(['runtime.log', 'runtime.log.1']))
    expect(files).not.toContain('runtime.log.3')
    const current = await readFile(path, 'utf8')
    expect(current).toContain('[supervisor]')
  })

  test('truncates oversized entries before writing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-rotating-log-entry-'))
    const path = join(directory, 'runtime.log')
    const log = new RotatingLog({ path, maxBytes: 1024, maxEntryBytes: 100 })

    await log.write('stdout', `token=secret-token ${'界'.repeat(100)}`)
    await log.flush()

    const content = await readFile(path, 'utf8')
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(100)
    expect(content).toContain('token=[REDACTED]')
    expect(content).toContain('… [truncated]')
  })
})
