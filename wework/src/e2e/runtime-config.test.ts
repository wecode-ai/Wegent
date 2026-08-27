import { afterEach, describe, expect, test } from 'vitest'
import { resolveDesktopE2ETranscriptPageSize } from './runtime-config'

afterEach(() => {
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
})

describe('desktop E2E runtime config', () => {
  test('resolves a runtime transcript page size injected after module import', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      transcriptPageSize: 20,
    }

    expect(resolveDesktopE2ETranscriptPageSize('50', 50)).toBe(20)
  })

  test('falls back when the configured transcript page size is invalid', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      transcriptPageSize: 0,
    }

    expect(resolveDesktopE2ETranscriptPageSize(undefined, 50)).toBe(50)
  })
})
