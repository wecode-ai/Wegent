import { describe, expect, it } from 'vitest'
import type { ModelSelectionConfig } from '@/types/api'
import {
  modelSelectionIdentityDiagnostics,
  modelSelectionScopeFingerprint,
} from './modelSelectionDiagnostics'

const selection: ModelSelectionConfig = {
  modelName: 'model-a',
  modelType: 'public',
  options: {
    weworkCloudModelNamespace: 'default',
    weworkCloudModelResourceUserId: '0',
    codexProviderId: 'provider-a',
    api_key: 'SYNTHETIC_SECRET',
    headers: 'private headers',
    reasoning: 'high',
  },
}

describe('model selection diagnostics', () => {
  it('includes only the model identity and excludes arbitrary configuration', () => {
    const identity = modelSelectionIdentityDiagnostics(selection)

    expect(identity).toEqual({
      modelName: 'model-a',
      modelType: 'public',
      namespace: 'default',
      resourceUserId: '0',
      codexProviderId: 'provider-a',
      fingerprint: expect.any(Number),
    })
    expect(JSON.stringify(identity)).not.toMatch(
      /SYNTHETIC_SECRET|private headers|api_key|reasoning/
    )
    expect(selection.options?.api_key).toBe('SYNTHETIC_SECRET')
  })

  it('correlates the same identity despite option ordering, controls and credential changes', () => {
    const reordered: ModelSelectionConfig = {
      ...selection,
      options: {
        codexProviderId: 'provider-a',
        weworkCloudModelResourceUserId: '0',
        weworkCloudModelNamespace: 'default',
        api_key: 'ROTATED_SECRET',
        reasoning: 'low',
      },
    }

    expect(modelSelectionIdentityDiagnostics(reordered)?.fingerprint).toBe(
      modelSelectionIdentityDiagnostics(selection)?.fingerprint
    )
  })

  it('distinguishes models, resource owners, namespaces, types and native providers', () => {
    const alternatives: ModelSelectionConfig[] = [
      { ...selection, modelName: 'model-b' },
      { ...selection, modelType: 'user' },
      { ...selection, options: { ...selection.options, weworkCloudModelNamespace: 'team' } },
      { ...selection, options: { ...selection.options, weworkCloudModelResourceUserId: '7' } },
      { ...selection, options: { ...selection.options, codexProviderId: 'provider-b' } },
    ]
    const fingerprints = [selection, ...alternatives].map(
      item => modelSelectionIdentityDiagnostics(item)?.fingerprint
    )

    expect(new Set(fingerprints).size).toBe(fingerprints.length)
    expect(modelSelectionScopeFingerprint('user:7:runtime:device:task-a')).not.toBe(
      modelSelectionScopeFingerprint('user:7:runtime:device:task-b')
    )
  })

  it('preserves missing model snapshots as null', () => {
    expect(modelSelectionIdentityDiagnostics()).toBeNull()
    expect(modelSelectionIdentityDiagnostics(null)).toBeNull()
    expect(modelSelectionIdentityDiagnostics({ modelName: '', modelType: null })).toBeNull()
  })
})
