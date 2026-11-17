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

  test.each([
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: [REDACTED]'],
    ['authorization=Bearer synthetic-token', 'authorization=[REDACTED]'],
    [
      '{"headers":{"Authorization":"Basic dXNlcjpwYXNz","Accept":"application/json"},"status":401}',
      '{"headers":{"Authorization":"[REDACTED]","Accept":"application/json"},"status":401}',
    ],
    [
      "headers: { authorization: 'Bearer synthetic-token', requestId: 'request-1' }",
      "headers: { authorization: '[REDACTED]', requestId: 'request-1' }",
    ],
    [
      'Authorization:\tBasic\tdXNlcjpwYXNz\r\nX-Request-Id: request-1\r\nstatus=401',
      'Authorization:\t[REDACTED]\r\nX-Request-Id: request-1\r\nstatus=401',
    ],
    [
      'request failed Authorization: Basic dXNlcjpwYXNz status=401; token=synthetic-token retry=false',
      'request failed Authorization: [REDACTED] status=401; token=[REDACTED] retry=false',
    ],
    [
      'Authorization: Bearer synthetic-token, requestId=request-1; status=401',
      'Authorization: [REDACTED], requestId=request-1; status=401',
    ],
    [
      '{"Authorization":"Digest username=\\"synthetic-user\\", response=\\"synthetic-response\\"","status":401}',
      '{"Authorization":"[REDACTED]","status":401}',
    ],
    [
      'Authorization: Digest username="synthetic-user", response="synthetic-response"\nstatus=401',
      'Authorization: [REDACTED]\nstatus=401',
    ],
    [
      'Authorization: Basic \u001b[31m dXNlcjpwYXNz\u001b[0m\nstatus=401',
      'Authorization: [REDACTED]\nstatus=401',
    ],
    [
      '{"Authorization":"Basic\\tdXNlcjpwYXNz\\r\\n","requestId":"request-1"}',
      '{"Authorization":"[REDACTED]","requestId":"request-1"}',
    ],
  ])(
    'redacts a complete authorization value without losing its surrounding diagnostics: %s',
    (input, expected) => {
      const result = redactLog(input)
      expect(result).toBe(expected)
      expect(redactLog(result)).toBe(expected)
    }
  )

  test('preserves diagnostics that do not contain credential fields', () => {
    const diagnostic = 'Authorization failed: 401; authorizationStatus=denied; requestId=request-1'
    expect(redactLog(diagnostic)).toBe(diagnostic)
  })

  test('never persists basic credentials while retaining the warning and request metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-authorization-log-'))
    const path = join(directory, 'runtime.log')
    const log = new RotatingLog({ path })
    await log.write(
      'stderr',
      'renderer warning {"Authorization":"Basic dXNlcjpwYXNz","requestId":"request-1","status":401}'
    )
    await log.flush()
    const content = await readFile(path, 'utf8')
    expect(content).not.toContain('dXNlcjpwYXNz')
    expect(content).toContain(
      'renderer warning {"Authorization":"[REDACTED]","requestId":"request-1","status":401}'
    )
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
