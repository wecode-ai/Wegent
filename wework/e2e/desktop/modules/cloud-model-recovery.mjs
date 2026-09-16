import assert from 'node:assert/strict'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_PUBLIC_MODEL_NAME,
  ensureModelOptionVisible,
  selectE2EModel,
  stopProcessGroup,
  waitForSnapshot,
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

  let backendStopped = false
  let createdModelId = null
  try {
    await stopProcessGroup(cloud.backend)
    backendStopped = true
    await assert.rejects(fetch(`${cloud.backendUrl}/api/health`))

    // Opening the menu requests a refresh; existing models remain visible while offline.
    await ensureModelOptionVisible(control, `model-option-${model.name}`, selector, null)
    // Cover the catalog request deadline before attempting a new refresh.
    const offlineUntil = Date.now() + 11_000
    while (Date.now() < offlineUntil) {
      assert.equal(await control.command('getText', selector), selectedLabel)
      assert.equal(await control.command('getText', ACTIVE_COMPOSER_SELECTOR), draft)
      assert.equal(control.readyCount, readyCount, 'The renderer reloaded during the outage')
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    await captureVerificationScreenshot(control, 'cloud-model-recovery-01-offline.png')

    await control.command('press', 'body', { key: 'Escape' })
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes('model-selector-menu'),
      'The model menu did not close before the next refresh'
    )
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

    // Reopening the menu fetches the updated catalog without restarting the app.
    await ensureModelOptionVisible(control, `model-option-${model.name}`, selector, null)
    await control.command('waitFor', `[data-testid="model-option-${name}"]`)
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
