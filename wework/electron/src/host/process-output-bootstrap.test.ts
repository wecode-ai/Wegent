import { afterEach, expect, test, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
vi.mock('./process-output.js', () => ({
  installProcessOutputErrorHandlers: () => calls.push('output-handlers'),
}))
vi.mock('./startup-step.js', () => ({
  logStartupStep: (step: string) => calls.push(step),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  calls.length = 0
})

test('protects output streams before writing the early diagnostic', async () => {
  vi.stubEnv('WEWORK_E2E_CORE_CPU_PROFILE', '1')

  await import('./process-output-bootstrap.js')

  expect(calls).toEqual(['output-handlers', 'electron-output-bootstrap'])
})

test('leaves ordinary startup output unchanged', async () => {
  vi.stubEnv('WEWORK_E2E_CORE_CPU_PROFILE', '0')

  await import('./process-output-bootstrap.js')

  expect(calls).toEqual(['output-handlers'])
})
