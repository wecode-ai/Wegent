import { expect, test } from 'vitest'
import { rendererConsoleDiagnostic } from './renderer-console-diagnostic.js'
import { redactLog } from '../runtime/rotating-log.js'

test.each([2, 3])(
  'removes complete Basic header values before renderer level %s reaches main-process logging',
  level => {
    const result = rendererConsoleDiagnostic({
      e2e: true,
      level,
      message:
        'request failed {"headers":{"Authorization":"Basic dXNlcjpwYXNz","Accept":"application/json"},"status":401}',
      sourceId: 'https://example.test/renderer.js?token=synthetic-source-secret',
    })
    expect(result?.data).toEqual({
      message:
        'request failed {"headers":{"Authorization":"[REDACTED]","Accept":"application/json"},"status":401}',
      sourcePath: '/renderer.js',
    })
    const mainProcessEntry = redactLog(JSON.stringify(result))
    expect(mainProcessEntry).not.toContain('dXNlcjpwYXNz')
    expect(mainProcessEntry).not.toContain('synthetic-source-secret')
    expect(mainProcessEntry).toContain('request failed')
    expect(mainProcessEntry).toContain('401')
  }
)

test('retains renderer warnings and errors after startup with the existing redaction boundary', () => {
  for (const [level, type] of [
    [2, 'renderer-warning'],
    [3, 'renderer-error'],
  ] as const) {
    const result = rendererConsoleDiagnostic({
      e2e: true,
      level,
      message: 'Authorization: Bearer renderer-secret',
      sourceId: 'https://example.test/renderer.js?token=source-secret',
    })
    expect(result?.type).toBe(type)
    expect(result?.data.sourcePath).toBe('/renderer.js')
    expect(JSON.stringify(result)).not.toContain('renderer-secret')
    expect(JSON.stringify(result)).not.toContain('source-secret')
  }
})

test('does not collect ordinary renderer output or change non-E2E behavior', () => {
  for (const level of [0, 1, 2, 3]) {
    expect(
      rendererConsoleDiagnostic({ e2e: false, level, message: 'ordinary', sourceId: '' })
    ).toBeNull()
  }
  for (const level of [0, 1]) {
    expect(
      rendererConsoleDiagnostic({ e2e: true, level, message: 'ordinary', sourceId: '' })
    ).toBeNull()
  }
  expect(
    rendererConsoleDiagnostic({
      e2e: true,
      level: 2,
      message: 'x'.repeat(5000),
      sourceId: 'unknown',
    })?.data.message
  ).toHaveLength(4096)
})
