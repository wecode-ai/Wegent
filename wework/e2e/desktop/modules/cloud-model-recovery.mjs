import assert from 'node:assert/strict'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_PUBLIC_MODEL_NAME,
  ensureModelOptionVisible,
  selectE2EModel,
  stopProcessGroup,
} from './shared.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

/** Exercise recovery against the real Backend without reloading the renderer or model settings. */
export async function verifyCloudModelRecovery(control, cloud, request) {
  assert.ok(cloud?.backend, 'Cloud model recovery requires the real Backend process')
  const catalog = await request(
    '/api/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework'
  )
  const model = catalog.data.find(candidate => candidate.name === CLOUD_PUBLIC_MODEL_NAME)
  assert.ok(model, 'The real Backend did not expose the cloud model fixture')
  await selectE2EModel(control, model.name, model.displayName || model.name)
  const selector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
  const selectedLabel = await control.command('getText', selector)
  const readyCount = control.readyCount
  const draft = 'Cloud model recovery must preserve this unsent draft'
  await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: draft })
  await ensureModelOptionVisible(control, `model-option-${model.name}`, selector, null)

  let backendStopped = false
  let createdModelId = null
  try {
    await stopProcessGroup(cloud.backend)
    backendStopped = true
    await assert.rejects(fetch(`${cloud.backendUrl}/api/health`))

    // Cross the normal sixty-second catalog refresh while the real server is down.
    // Assert continuity throughout the outage rather than manually triggering a reload.
    const offlineUntil = Date.now() + 65_000
    while (Date.now() < offlineUntil) {
      assert.equal(await control.command('getText', selector), selectedLabel)
      assert.equal(await control.command('getText', ACTIVE_COMPOSER_SELECTOR), draft)
      assert.equal(control.readyCount, readyCount, 'The renderer reloaded during the outage')
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    await captureVerificationScreenshot(control, 'cloud-model-recovery-01-offline.png')

    await cloud.launchBackend()
    backendStopped = false
    const name = `cloud-model-recovery-${process.pid}-${Date.now()}`
    const created = await request('/api/models/batch', {
      method: 'POST',
      body: JSON.stringify([
        {
          name,
          env: {
            model: 'openai',
            model_id: name,
            base_url: `${cloud.modelServerUrl}/v1`,
            api_key: 'desktop-e2e',
          },
          is_active: true,
          wework_available: true,
          protocol: 'openai-responses',
          api_format: 'responses',
        },
      ]),
    })
    createdModelId = created.created[0]?.id
    assert.ok(createdModelId, 'The recovery model was not persisted by the real Backend')

    // Allow the capped background retry and its request deadline, without user input.
    await control.command('waitFor', `[data-testid="model-option-${name}"]`, {
      timeoutMs: 75_000,
    })
    assert.equal(await control.command('getText', selector), selectedLabel)
    assert.equal(await control.command('getText', ACTIVE_COMPOSER_SELECTOR), draft)
    assert.equal(control.readyCount, readyCount, 'Recovery required a renderer reload')
    await captureVerificationScreenshot(control, 'cloud-model-recovery-02-recovered.png')
  } finally {
    if (backendStopped) await cloud.launchBackend()
    if (createdModelId) await request(`/api/models/${createdModelId}`, { method: 'DELETE' })
    await control.command('press', 'body', { key: 'Escape' })
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: '' })
  }
}
