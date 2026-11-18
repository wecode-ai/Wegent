import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { e2eErrorLog } from '../host/e2e-error-log.js'
import { recordReleaseDiagnostic } from './release-diagnostics.js'
import { traceShutdownStep } from './shutdown-diagnostics.js'

vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeSync: vi.fn(),
}))

describe('shutdown diagnostics', () => {
  let root: string
  const records = () =>
    readFileSync(join(root, 'activation-diagnostics.log'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line.slice(line.indexOf('{'))))

  beforeEach(() => {
    vi.mocked(writeSync).mockReset()
    root = mkdtempSync(join(tmpdir(), 'wework-shutdown-'))
    vi.stubEnv('WEWORK_RELEASE_ROOT', root)
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://localhost:1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('records shutdown stages in ordinary E2E sessions without a release slot', async () => {
    vi.stubEnv('WEWORK_RELEASE_ROOT', '')
    const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
    await expect(traceShutdownStep('desktop-runtime', () => 42)).resolves.toBe(42)
    expect(record).toHaveBeenNthCalledWith(
      1,
      'main',
      'shutdown-step',
      'info',
      expect.objectContaining({ step: 'desktop-runtime', status: 'started', pid: process.pid })
    )
    expect(record).toHaveBeenNthCalledWith(
      2,
      'main',
      'shutdown-step',
      'info',
      expect.objectContaining({ step: 'desktop-runtime', status: 'completed', pid: process.pid })
    )
    const failure = new TypeError('private service state')
    await expect(
      traceShutdownStep('service', () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(record).toHaveBeenLastCalledWith(
      'main',
      'shutdown-step',
      'error',
      expect.objectContaining({ status: 'failed', errorType: 'TypeError' })
    )
    expect(JSON.stringify(record.mock.calls)).not.toContain(failure.message)
  })

  it('persists the pending phase before an operation finishes', async () => {
    let finish!: (value: number) => void
    const operation = new Promise<number>(resolve => {
      finish = resolve
    })
    const result = traceShutdownStep('service', () => operation)
    expect(records()).toEqual([expect.objectContaining({ step: 'service', status: 'started' })])
    finish(42)
    await expect(result).resolves.toBe(42)
    expect(records().map(record => record.status)).toEqual(['started', 'completed'])
  })

  it('preserves failures without recording their sensitive messages', async () => {
    const failure = new TypeError('private service state')
    await expect(
      traceShutdownStep('service', () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(records()[1]).toMatchObject({ status: 'failed', errorType: 'TypeError' })
    expect(readFileSync(join(root, 'activation-diagnostics.log'), 'utf8')).not.toContain(
      failure.message
    )
  })

  it('redacts synchronous records and keeps diagnostic failures nonfatal', async () => {
    recordReleaseDiagnostic('test', { token: 'sensitive-value' }, true)
    expect(records()[0].token).toBe('[REDACTED]')
    vi.stubEnv('WEWORK_RELEASE_ROOT', join(root, 'missing-directory'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(traceShutdownStep('service', () => 42)).resolves.toBe(42)
    expect(error).toHaveBeenCalled()
  })

  it('keeps redacted shutdown evidence for ordinary desktop E2E sessions', async () => {
    vi.stubEnv('WEWORK_RELEASE_ROOT', '')
    await expect(traceShutdownStep('desktop-runtime', () => 42)).resolves.toBe(42)
    recordReleaseDiagnostic('application-quit', { token: 'sensitive-value' }, true)
    const messages = vi.mocked(writeSync).mock.calls.map(([, message]) => String(message))
    expect(messages).toHaveLength(3)
    expect(messages[0]).toContain('"status":"started"')
    expect(messages[1]).toContain('"status":"completed"')
    expect(messages[2]).toContain('[application-quit]')
    expect(messages.join('\n')).not.toContain('sensitive-value')
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(() => recordReleaseDiagnostic('startup-step', circular, true)).not.toThrow()
    expect(() => records()).toThrow()
  })

  it('keeps cleanup running if synchronous E2E output is unavailable', async () => {
    vi.stubEnv('WEWORK_RELEASE_ROOT', '')
    vi.mocked(writeSync).mockImplementationOnce(() => {
      throw new Error('closed output')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(traceShutdownStep('service', () => 42)).resolves.toBe(42)
    expect(error).toHaveBeenCalled()
  })

  it('does not create diagnostic files outside an E2E session', async () => {
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', '')
    const record = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
    await expect(traceShutdownStep('service', () => 42)).resolves.toBe(42)
    expect(record).not.toHaveBeenCalled()
    expect(() => records()).toThrow()
  })
})
