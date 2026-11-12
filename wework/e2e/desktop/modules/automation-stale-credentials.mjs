import assert from 'node:assert/strict'

import { requestExecutor } from './executor-rpc.mjs'

// Persist an invalid historical token through the real automation API. The next
// run must resolve current credentials before it can reach the model service.
export async function expireAutomationCredentials(control, automationId, timeoutMs) {
  const { automation } = await requestExecutor(
    control,
    'runtime.automations.get',
    { automationId },
    timeoutMs
  )
  let changed = 0
  for (const key of ['taskPayload', 'continuationPayload']) {
    const payload = automation[key]
    if (!payload) continue
    for (const config of [
      payload.modelConfig,
      payload.executionRequest?.model_config,
      payload.execution_request?.model_config,
    ]) {
      if (!config?.default_headers?.['X-Wegent-Model-Type']) continue
      config.api_key = 'synthetic-expired-automation-token'
      changed += 1
    }
  }
  assert.ok(changed > 0, 'The automation fixture did not contain a cloud gateway config')
  const updated = await requestExecutor(
    control,
    'runtime.automations.update',
    { automation },
    timeoutMs
  )
  assert.ok(updated.automation.version > automation.version)
}
