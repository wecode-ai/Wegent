// @vitest-environment node

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

  test('retains submit guards without storing the submitted draft', () => {
    recordComposerDiagnostic('submit-policy', {
      valueLength: 19,
      isModelSelectionReady: false,
      disabled: false,
      submitDisabled: false,
      value: 'private submission',
    })
    expect(getComposerDiagnosticsSnapshot()?.events[0]?.details).toEqual({
      valueLength: 19,
      isModelSelectionReady: false,
      disabled: false,
      submitDisabled: false,
    })
    expect(JSON.stringify(getComposerDiagnosticsSnapshot())).not.toContain('private submission')
  })

  test('retains bounded model submission identity without arbitrary model configuration', () => {
    recordComposerDiagnostic('model-selection-submit', {
      scopeFingerprint: 7,
      selectionRevision: 3,
      renderedModelName: 'visible-model',
      liveModelName: 'x'.repeat(200),
      liveProviderId: 'provider',
      modelOptions: { api_key: 'SYNTHETIC_SECRET' },
      prompt: 'PRIVATE_PROMPT',
    })

    expect(getComposerDiagnosticsSnapshot()?.events[0]?.details).toEqual({
      scopeFingerprint: 7,
      selectionRevision: 3,
      renderedModelName: 'visible-model',
      liveModelName: 'x'.repeat(80),
      liveProviderId: 'provider',
    })
    expect(JSON.stringify(getComposerDiagnosticsSnapshot())).not.toMatch(
      /SYNTHETIC_SECRET|PRIVATE_PROMPT|modelOptions/
    )
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
