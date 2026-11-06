import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordReleaseDiagnostic } from './release-diagnostics.js'
import { traceShutdownStep } from './shutdown-diagnostics.js'

describe('shutdown diagnostics', () => {
  let root: string
  const records = () =>
    readFileSync(join(root, 'activation-diagnostics.log'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line.slice(line.indexOf('{'))))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wework-shutdown-'))
    vi.stubEnv('WEWORK_RELEASE_ROOT', root)
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', 'http://localhost:1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
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

  it('does not create diagnostic files outside an E2E session', async () => {
    vi.stubEnv('WEWORK_E2E_CONTROL_URL', '')
    await expect(traceShutdownStep('service', () => 42)).resolves.toBe(42)
    expect(() => records()).toThrow()
  })
})
