import { SMART_APP_OPERATION_DEFINITIONS } from './generated/smartAppEvents'
import type { SmartAppOperationKey } from './generated/smartAppEvents'
import type { WeworkTelemetryContext } from './facts'

export interface OperationResult {
  readonly context?: WeworkTelemetryContext
  readonly failureStage?: string
  readonly key: SmartAppOperationKey
  readonly outcome: 'failed' | 'succeeded'
}

export interface OperationAttempt {
  cancel(): void
  fail(failureStage: string, detail?: OperationResultDetail): boolean
  succeed(detail?: OperationResultDetail): boolean
}

export interface OperationResultDetail {
  readonly context?: WeworkTelemetryContext
}

const listeners = new Set<(result: OperationResult) => void>()

export function beginOperation(key: SmartAppOperationKey): OperationAttempt {
  const definition = SMART_APP_OPERATION_DEFINITIONS.find(operation => operation.key === key)
  if (!definition) throw new Error(`Unknown Smart App operation: ${key}`)

  let completed = false
  const finish = (result: OperationResult): boolean => {
    if (completed) return false
    completed = true
    for (const listener of listeners) listener(result)
    return true
  }

  return {
    cancel: () => {
      completed = true
    },
    fail: (failureStage, detail = {}) => {
      if (!definition.failureStages.includes(failureStage as never)) {
        throw new Error(`Unsupported failure stage for ${key}: ${failureStage}`)
      }
      return finish({ ...detail, failureStage, key, outcome: 'failed' })
    },
    succeed: (detail = {}) => finish({ ...detail, key, outcome: 'succeeded' }),
  }
}

export function subscribeOperationResults(listener: (result: OperationResult) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
