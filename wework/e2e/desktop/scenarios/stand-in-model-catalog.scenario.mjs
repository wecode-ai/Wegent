import assert from 'node:assert/strict'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_PUBLIC_MODEL_NAME,
  ensureModelOptionVisible,
  fetchJson,
} from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const PANEL = '[data-testid="stand-in-primary-profile"]'
const models = [
  { name: 'catalog-kimi-intranet', label: '内网:Kimi-K3' },
  { name: 'catalog-kimi-public', label: '公网:Kimi-K3' },
  { name: 'catalog-kimi-unmarked', label: 'Kimi-K3' },
]
const selector = id => `[data-testid=${JSON.stringify(id)}]`

/** Compare the ordinary picker and stand-in picker against the same real Backend catalog. */
export function createDesktopScenario({ uiTimeoutMs }) {
  let cloud
  let userId
  const createdIds = new Set()
  const request = (path, options = {}) =>
    fetchJson(`${cloud.backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
    })
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', { method: 'POST' })
      const user = await request('/api/users/me')
      userId = user.id
      assert.ok(Number.isInteger(userId), 'The real Backend must identify the signed-in user')
      const catalog = await request('/api/admin/public-models?limit=1000')
      const upstream = catalog.items.find(model => model.name === CLOUD_PUBLIC_MODEL_NAME)
      assert.ok(upstream, 'The real Backend must expose its upstream model fixture')
      for (const model of models) {
        const created = await request('/api/admin/public-models', {
          method: 'POST',
          body: JSON.stringify({
            name: model.name,
            namespace: 'default',
            json: {
              apiVersion: 'agent.wecode.io/v1',
              kind: 'Model',
              metadata: { name: model.name, namespace: 'default', displayName: model.label },
              spec: {
                protocol: 'openai-responses',
                apiFormat: 'responses',
                modelType: 'llm',
                isVisible: true,
                isWeworkAvailable: true,
                modelConfig: {
                  env: { ...upstream.json.spec.modelConfig.env, model_id: 'kimi-k3' },
                },
              },
            },
          }),
        })
        createdIds.add(created.id)
      }
    },
    async cleanup() {
      const results = await Promise.allSettled(
        [...createdIds].map(async id => {
          const response = await fetch(`${cloud.backendUrl}/api/admin/public-models/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${cloud.authToken}` },
          })
          assert.equal(response.status, 204, 'Catalog fixture cleanup must return 204')
          createdIds.delete(id)
        })
      )
      const errors = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Catalog fixture cleanup failed')
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const initial = await rpc('runtime.stand_in.personal.get', { userId })
      const errors = []
      try {
        const ordinaryTrigger = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
        for (const model of models) {
          await ensureModelOptionVisible(
            control,
            `model-option-${model.name}`,
            ordinaryTrigger,
            null
          )
          await control.command('waitFor', selector(`model-option-${model.name}`), {
            text: model.label,
          })
          await control.command('press', 'body', { key: 'Escape' })
        }
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('click', '[data-testid="collaboration-primary-stand-in"]')
        for (const model of models) {
          await control.command('click', '[data-testid="stand-in-settings-open"]')
          await control.command('waitFor', PANEL)
          const key = JSON.stringify(['codex', 'cloud', 'public', 'default', 0, model.name])
          const optionId = `model-option-${key}`
          await control.command(
            'clickWhenEnabled',
            `${PANEL} [data-testid="model-selector-button"]`
          )
          await control.command('waitFor', selector(optionId))
          await control.command('scrollIntoView', selector(optionId))
          await control.command('waitFor', selector(optionId), { text: model.label })
          await control.command('clickWhenEnabled', selector(optionId))
          await control.command('press', 'body', { key: 'Escape' })
          await control.command('waitFor', `${PANEL} [data-testid="model-selector-button"]`, {
            text: model.label,
          })
          await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
          await control.command('waitFor', PANEL, { visible: false })
          const saved = await rpc('runtime.stand_in.personal.get', { userId })
          assert.deepEqual(saved.primary.model.cloud_model, {
            name: model.name,
            type: 'public',
            namespace: 'default',
            resource_user_id: 0,
          })
          assert.deepEqual(Object.keys(saved.primary.model).sort(), [
            'cloud_model',
            'model_id',
            'provider',
            'runtime',
            'source',
          ])
          assert.equal(saved.primary.model.runtime, 'codex')
          assert.equal(saved.primary.model.source, 'cloud')
          assert.equal(saved.primary.model.model_id, 'kimi-k3')
        }
      } catch (error) {
        console.error('[stand-in-model-catalog] Verification failed', error)
        errors.push(error)
      } finally {
        try {
          const latest = await rpc('runtime.stand_in.personal.get', { userId })
          await rpc('runtime.stand_in.personal.save', {
            userId,
            settings: { ...initial, version: latest.version },
          })
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1)
        throw new AggregateError(errors, 'Shared model catalog verification failed')
    },
  }
}
