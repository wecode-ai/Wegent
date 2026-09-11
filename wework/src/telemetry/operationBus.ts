import { PLUGIN_OPERATION_DEFINITIONS, type PluginOperationKey } from './generated/pluginEvents'
import { SMART_APP_OPERATION_DEFINITIONS } from './generated/smartAppEvents'
import type { SmartAppOperationKey } from './generated/smartAppEvents'
import type { WeworkTelemetryContext } from './facts'

export interface OperationResult {
  readonly context?: WeworkTelemetryContext
  readonly failureStage?: string
  readonly key: OperationKey
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

export type OperationKey = SmartAppOperationKey | PluginOperationKey

const definitions = [...SMART_APP_OPERATION_DEFINITIONS, ...PLUGIN_OPERATION_DEFINITIONS]

const listeners = new Set<(result: OperationResult) => void>()

export function beginOperation(key: OperationKey): OperationAttempt {
  const definition = definitions.find(operation => operation.key === key)
  if (!definition) throw new Error(`Unknown telemetry operation: ${key}`)

  let completed = false
  const finish = (result: OperationResult): boolean => {
    if (completed) return false
    completed = true
    for (const listener of listeners) {
      try {
        listener(result)
      } catch {
        /* Observers must not change the business result. */
      }
    }
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
