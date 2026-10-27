import { afterEach, expect, test, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { waitForCatalogRestart } from '../e2e/desktop/scenarios/codex-catalog-context.mjs'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function restartLog(operation, { started = true, served = true, ok = true } = {}) {
  return [
    `app IPC request finished request_id=write method=runtime.codex.catalog.overrides.${operation} elapsed_ms=1 ok=true`,
    'app IPC request started request_id=restart method=runtime.codex.app_server.restart',
    ...(started ? ['codex shared app-server process starting process_id=123'] : []),
    ...(served ? ['codex router model catalog served model_count=8'] : []),
    `app IPC request finished request_id=restart method=runtime.codex.app_server.restart elapsed_ms=1 ok=${ok}`,
  ].join('\n')
}

function controlFixture(snapshots) {
  let index = 0
  return {
    command: vi.fn(async action => {
      if (action === 'snapshot') {
        const confirmation = snapshots[Math.min(index++, snapshots.length - 1)]
        return JSON.stringify({
          text: confirmation ? '立即重启 Codex？' : '',
          testIds: confirmation ? ['local-model-catalog-restart-dialog'] : [],
        })
      }
      return ''
    }),
  }
}

test.each(['write', 'delete'])(
  'handles restart confirmation before accepting a completed catalog %s',
  async operation => {
    vi.useFakeTimers()
    vi.mocked(readFile).mockResolvedValue(restartLog(operation))
    const control = controlFixture([true, true, false])
    let finished = false
    const verification = waitForCatalogRestart(control, '/fixture/executor.log', 0).then(() => {
      finished = true
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(finished).toBe(false)
    expect(control.command).toHaveBeenCalledWith(
      'clickWhenEnabled',
      '[data-testid="local-model-catalog-restart-now-button"]'
    )
    await vi.advanceTimersByTimeAsync(100)
    await verification
    expect(
      control.command.mock.calls.filter(([action]) => action === 'clickWhenEnabled')
    ).toHaveLength(1)
  }
)

test.each([{ started: false }, { served: false }, { ok: false }])(
  'does not treat an incomplete restart as completion: %j',
  async options => {
    vi.useFakeTimers()
    vi.mocked(readFile).mockResolvedValue(restartLog('write', options))
    const control = controlFixture([false])
    const rejected = expect(
      waitForCatalogRestart(control, '/fixture/executor.log', 0)
    ).rejects.toThrow('The saved Catalog was not loaded by a restarted Codex app-server')

    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
  }
)

test('preserves a rejected explicit restart instead of accepting old log evidence', async () => {
  vi.mocked(readFile).mockResolvedValue(restartLog('write'))
  const control = controlFixture([true])
  control.command.mockImplementation(async action => {
    if (action === 'snapshot')
      return JSON.stringify({ text: '', testIds: ['local-model-catalog-restart-dialog'] })
    throw new Error('Restart rejected')
  })

  await expect(waitForCatalogRestart(control, '/fixture/executor.log', 0)).rejects.toThrow(
    'Restart rejected'
  )
})
