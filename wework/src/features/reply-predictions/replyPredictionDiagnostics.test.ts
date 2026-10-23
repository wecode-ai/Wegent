import { afterEach, describe, expect, it } from 'vitest'
import {
  getConversationDiagnosticsSnapshot,
  recordConversationDiagnostic,
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from '@wegent/collaboration/conversation/conversationDiagnostics'
import {
  recordPredictionEffect,
  type PredictionEffectDiagnosticContext,
} from './replyPredictionDiagnostics'
import {
  ReplyPredictionService,
  replyPredictionKey,
  type ReplyPredictionSource,
} from './replyPredictionService'

const source: ReplyPredictionSource = {
  scope: '["private-device","private-task","/private/workspace"]',
  revision: 'private-turn',
  latestTurnId: 'private-turn',
  busy: false,
  address: {
    deviceId: 'private-device',
    taskId: 'private-task',
    workspacePath: '/private/workspace',
  },
  modelSelection: {
    modelName: 'private-model',
    modelType: 'runtime',
    options: { apiKey: 'synthetic-private-token', baseUrl: 'https://private.example/path' },
  },
}

function context(model = source.modelSelection): PredictionEffectDiagnosticContext {
  const next = { ...source, modelSelection: model }
  return {
    api: {},
    service: {},
    source: next,
    key: replyPredictionKey(next),
    busy: false,
    enabled: true,
  }
}

describe('reply prediction diagnostics', () => {
  afterEach(() => resetConversationDiagnosticsForTest())

  it('does not inspect configuration or record events while capture is disabled', () => {
    const metadata = context()
    Object.defineProperty(metadata.source!, 'modelSelection', {
      get: () => {
        throw new Error('Diagnostic configuration must not be inspected')
      },
    })

    expect(() => recordPredictionEffect('start', {}, metadata)).not.toThrow()
    expect(getConversationDiagnosticsSnapshot()).toBeNull()
  })

  it('records field order and semantic fingerprints without configuration values or task identities', () => {
    startConversationDiagnosticCapture()
    const first = context()
    const second = context({
      options: { baseUrl: 'https://private.example/path', apiKey: 'synthetic-private-token' },
      modelType: 'runtime',
      modelName: 'private-model',
    })
    const provider = {}
    recordPredictionEffect('start', provider, first)
    recordPredictionEffect('start', provider, { ...second, api: first.api, service: first.service })

    const events = getConversationDiagnosticsSnapshot()!.events
    expect(events[0].details.predictionProviderId).toBe(events[1].details.predictionProviderId)
    expect(events[0].details.predictionApiId).toBe(events[1].details.predictionApiId)
    expect(events[0].details.predictionServiceId).toBe(events[1].details.predictionServiceId)
    expect(events[0].details.predictionModelHash).not.toBe(events[1].details.predictionModelHash)
    expect(events[0].details.predictionModelSemanticHash).toBe(
      events[1].details.predictionModelSemanticHash
    )
    expect(events[0].details.predictionKeyHash).toBe(events[1].details.predictionKeyHash)
    expect(events[0].details.modelFieldOrder).toBe('modelName,modelType,options')
    expect(events[1].details.modelFieldOrder).toBe('options,modelType,modelName')
    expect(events[0].details.optionFieldOrder).toBe('apiKey,baseUrl')
    expect(events[1].details.optionFieldOrder).toBe('baseUrl,apiKey')
    const serialized = JSON.stringify(events)
    for (const value of [
      'private-device',
      'private-task',
      '/private/workspace',
      'private-turn',
      'private-model',
      'synthetic-private-token',
      'https://private.example/path',
    ]) {
      expect(serialized).not.toContain(value)
    }
  })

  it('rejects values disguised as diagnostic field names and limits the exception to prediction events', () => {
    startConversationDiagnosticCapture()
    recordConversationDiagnostic('reply-prediction-effect-start', {
      modelFieldOrder: '/private/workspace',
      optionFieldOrder: 'baseUrl,https://private.example?token=synthetic',
      modelSelection: source.modelSelection,
      predictionKey: replyPredictionKey(source),
    })
    recordConversationDiagnostic('markdown-layout', { modelFieldOrder: 'modelName,options' })
    expect(getConversationDiagnosticsSnapshot()!.events.map(event => event.details)).toEqual([
      {},
      {},
    ])
  })

  it('correlates owner release and busy invalidation without changing cancellation behavior', async () => {
    startConversationDiagnosticCapture()
    const api = { predict: async () => new Promise<{ suggestion: string | null }>(() => {}) }
    const service = new ReplyPredictionService(api)
    const first = service.retain(source.scope)
    const second = service.retain(source.scope)
    void service.request(source)
    first()
    expect(service.isPending(source.scope)).toBe(true)
    second()
    expect(service.isPending(source.scope)).toBe(false)
    const release = service.retain(source.scope)
    void service.request(source)
    service.invalidate(source.scope, 'busy')
    expect(service.isPending(source.scope)).toBe(false)
    release()

    const events = getConversationDiagnosticsSnapshot()!.events
    expect(
      events
        .filter(event => event.name === 'reply-prediction-release')
        .map(event => event.details.ownerCount)
    ).toEqual([1, 0, 0])
    expect(
      events.filter(event => event.name === 'reply-prediction-abort').map(event => event.details)
    ).toEqual([
      expect.objectContaining({ lastOwnerReleased: true, ownerCount: 0, settled: false }),
      expect.objectContaining({
        busy: true,
        ownerCount: 1,
        requestKeyChanged: false,
        taskRemoved: false,
      }),
    ])
    expect(new Set(events.map(event => event.details.predictionServiceId)).size).toBe(1)
    expect(new Set(events.map(event => event.details.predictionApiId)).size).toBe(1)
    expect(JSON.stringify(events)).not.toContain(source.scope)
  })
})
