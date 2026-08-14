import { beforeEach, describe, expect, test } from 'vitest'
import {
  classifyComposerInputData,
  getComposerDiagnosticsSnapshot,
  recordComposerDiagnostic,
  resetComposerDiagnosticsForTest,
} from './composerDiagnostics'

describe('composer diagnostics', () => {
  beforeEach(() => {
    resetComposerDiagnosticsForTest()
  })

  test('captures safe event metadata without retaining unknown text fields', () => {
    recordComposerDiagnostic('before-input', {
      inputType: 'insertCompositionText',
      dataLength: 8,
      dataKind: 'ascii-letters',
      valueLength: 12,
      content: 'sensitive draft',
    })

    const snapshot = getComposerDiagnosticsSnapshot()

    expect(snapshot?.events).toHaveLength(1)
    expect(snapshot?.events[0]?.details).toEqual({
      inputType: 'insertCompositionText',
      dataLength: 8,
      dataKind: 'ascii-letters',
      valueLength: 12,
    })
    expect(JSON.stringify(snapshot)).not.toContain('sensitive draft')
  })

  test('classifies input data without preserving its contents', () => {
    expect(classifyComposerInputData('zhongwen')).toEqual({
      dataLength: 8,
      dataKind: 'ascii-letters',
    })
    expect(classifyComposerInputData('中文')).toEqual({
      dataLength: 2,
      dataKind: 'non-ascii',
    })
    expect(classifyComposerInputData(null)).toEqual({
      dataLength: 0,
      dataKind: 'absent',
    })
  })
})
