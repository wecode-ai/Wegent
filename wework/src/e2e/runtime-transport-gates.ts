interface Match {
  path: string
  equals: unknown
}

export interface RuntimeTransportGateRule {
  id: string
  kind: 'response' | 'event'
  name: string
  where?: Match[]
  hold?: boolean
  holdFollowing?: boolean
}

interface Capture {
  value: unknown
  capturedAt: number
  deliveredAt?: number
  deliveries: number
  deliver: () => void
}

const gates = new Map<
  string,
  { rule: RuntimeTransportGateRule; capture?: Capture; following: Array<() => void> }
>()

function requireE2E(): void {
  if (import.meta.env.MODE !== 'e2e' && import.meta.env.VITE_WEWORK_E2E !== 'true') {
    throw new Error('Runtime transport gates are only available in E2E mode')
  }
}

function valuesAt(value: unknown, path: string[]): unknown[] {
  if (!path.length) return [value]
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (path[0] === '**') {
    return [
      ...valuesAt(value, path.slice(1)),
      ...Object.values(record).flatMap(child => valuesAt(child, path)),
    ]
  }
  if (path[0] === '*') {
    return Object.values(record).flatMap(child => valuesAt(child, path.slice(1)))
  }
  return valuesAt(record[path[0]], path.slice(1))
}

export function armRuntimeTransportGate(rule: RuntimeTransportGateRule): void {
  requireE2E()
  if (gates.has(rule.id)) throw new Error(`Duplicate runtime gate: ${rule.id}`)
  gates.set(rule.id, { rule, following: [] })
}

// Only postpone or repeat an original transport delivery. Never fabricate runtime state.
export function deliverRuntimeTransport(
  kind: RuntimeTransportGateRule['kind'],
  name: string,
  value: unknown,
  deliver: () => void
): void {
  const gate = [...gates.values()].find(
    candidate =>
      candidate.rule.kind === kind &&
      candidate.rule.name === name &&
      ((!candidate.capture &&
        (candidate.rule.where ?? []).every(match =>
          valuesAt(value, match.path.split('.')).some(found => found === match.equals)
        )) ||
        (candidate.capture && candidate.rule.holdFollowing === true))
  )
  if (!gate) return deliver()
  if (gate.capture) {
    gate.following.push(deliver)
    return
  }
  const capture: Capture = {
    value: structuredClone(value),
    capturedAt: performance.now(),
    deliveries: 0,
    deliver() {
      capture.deliveredAt = performance.now()
      capture.deliveries += 1
      deliver()
    },
  }
  gate.capture = capture
  if (gate.rule.hold === false) capture.deliver()
}

export function gateRuntimeResponse<T>(
  method: string,
  params: Record<string, unknown>,
  result: T
): Promise<T> {
  return new Promise(resolve =>
    deliverRuntimeTransport('response', method, { params, result }, () => resolve(result))
  )
}

export function readRuntimeTransportGate(id: string): Omit<Capture, 'deliver'> | null {
  requireE2E()
  const capture = gates.get(id)?.capture
  if (!capture) return null
  return {
    value: capture.value,
    capturedAt: capture.capturedAt,
    deliveredAt: capture.deliveredAt,
    deliveries: capture.deliveries,
  }
}

export function releaseRuntimeTransportGate(id: string): void {
  requireE2E()
  const gate = gates.get(id)
  if (!gate?.capture) throw new Error(`Runtime gate has not captured a delivery: ${id}`)
  gate.capture.deliver()
}

export function resetRuntimeTransportGates(keep: string[] = []): void {
  requireE2E()
  for (const [id, { capture, following }] of gates) {
    if (keep.includes(id)) continue
    if (capture && !capture.deliveries) capture.deliver()
    following.forEach(deliver => deliver())
    gates.delete(id)
  }
}
