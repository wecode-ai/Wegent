import { beforeEach, expect, test, vi } from 'vitest'

beforeEach(() => vi.resetModules())

test('captures renderer transport phases without command or result contents', async () => {
  const { recordDesktopControlPhase, getDesktopControlDiagnostics } =
    await import('./desktop-control-diagnostics')
  const command = {
    id: 'command-1',
    action: 'fill' as const,
    selector: 'private-selector',
    value: 'private-value',
  }
  recordDesktopControlPhase('command-decoded', command)
  const trace = getDesktopControlDiagnostics()
  expect(trace).toEqual([
    expect.objectContaining({ phase: 'command-decoded', commandId: 'command-1', action: 'fill' }),
  ])
  expect(Number.isFinite(trace[0].monotonicMs)).toBe(true)
  expect(Number.isFinite(Date.parse(trace[0].at))).toBe(true)
  expect(JSON.stringify(trace)).not.toContain('private-')
  trace[0].phase = 'changed-copy'
  expect(getDesktopControlDiagnostics()[0].phase).toBe('command-decoded')
})

test('bounds renderer transport diagnostics', async () => {
  const { recordDesktopControlPhase, getDesktopControlDiagnostics } =
    await import('./desktop-control-diagnostics')
  for (let index = 0; index < 110; index += 1) recordDesktopControlPhase(String(index))
  expect(getDesktopControlDiagnostics()).toHaveLength(100)
  expect(getDesktopControlDiagnostics()[0].phase).toBe('10')
})
