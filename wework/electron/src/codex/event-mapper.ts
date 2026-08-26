export interface DshProjectionEvent {
  type: string
  data: Record<string, unknown>
  source: {
    kind: 'plugin'
    plugin: 'wegent-codex-projection'
  }
}

const source = {
  kind: 'plugin' as const,
  plugin: 'wegent-codex-projection' as const,
}

export function mapCodexEvent(event: string, payload: Record<string, unknown>): DshProjectionEvent {
  const method = typeof payload.method === 'string' ? payload.method : event
  if (method === 'item/agentMessage/delta') {
    return { type: 'assistant/chunk', data: payload, source }
  }
  if (method.toLowerCase().includes('reasoning') && method.toLowerCase().endsWith('delta')) {
    return { type: 'assistant/reasoning-chunk', data: payload, source }
  }
  if (method === 'item/started') {
    return { type: 'codex/item-started', data: payload, source }
  }
  if (method === 'item/completed') {
    return { type: 'codex/item-completed', data: payload, source }
  }
  if (method.endsWith('/requestApproval')) {
    return { type: 'codex/approval-requested', data: payload, source }
  }
  if (method === 'turn/completed') {
    return { type: 'turn/end', data: payload, source }
  }
  return { type: 'codex/raw', data: { event, ...payload }, source }
}
