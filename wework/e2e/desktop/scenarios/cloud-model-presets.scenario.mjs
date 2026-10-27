import assert from 'node:assert/strict'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_PUBLIC_MODEL_NAME,
  ensureModelOptionVisible,
  fetchJson,
} from '../modules/shared.mjs'

const models = [
  { name: 'preset-glm', label: 'Preset GLM', family: 'glm' },
  { name: 'preset-deepseek', label: 'Preset DeepSeek', family: 'deepseek' },
  { name: 'preset-sol', label: 'Preset Sol', family: 'gpt', effort: 'medium' },
  { name: 'preset-astra', label: 'Preset Astra', family: 'gpt', effort: 'high' },
  {
    name: 'preset-long',
    label: 'Preset Long Model Name With Complete Account And Deployment Information 完整模型名称',
    family: 'gpt',
    effort: 'medium',
    efforts: ['low', 'medium', 'high'],
  },
]
const cloudSource = '[data-testid="model-source-cloud"]'
const recommended = `${cloudSource} > [data-model-preset="recommended"]`

export function createDesktopScenario({ captureScreenshot }) {
  let cloudEnvironment
  const createdIds = []
  const request = (path, options = {}) =>
    fetchJson(`${cloudEnvironment.backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cloudEnvironment.authToken}`,
        'Content-Type': 'application/json',
      },
    })

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(cloud) {
      cloudEnvironment = cloud
      await request('/api/admin/setup-complete', { method: 'POST' })
      const catalog = await request('/api/admin/public-models?limit=1000')
      const upstream = catalog.items.find(model => model.name === CLOUD_PUBLIC_MODEL_NAME)
      assert.ok(upstream, 'The real Backend must provide the upstream model fixture')
      for (const model of models) {
        const ui = {
          family: model.family,
          ...(model.effort
            ? {
                reasoningEfforts: model.efforts ?? [model.effort],
                defaultReasoningEffort: model.effort,
              }
            : {}),
        }
        if (model.name === 'preset-deepseek') {
          Object.assign(ui, {
            defaultModel: true,
            sliderModelsConfig: {
              defaultPreset: 'recommended',
              presets: [
                {
                  name: 'recommended',
                  label: '推荐',
                  models: models.map(target => ({
                    modelName: target.name,
                    ...(target.effort ? { reasoningEffort: target.effort } : {}),
                  })),
                },
                {
                  name: 'quality',
                  label: '高质量',
                  models: [{ modelName: 'preset-astra', reasoningEffort: 'high' }],
                },
                {
                  name: 'unavailable',
                  label: '不可用',
                  models: [{ modelName: 'preset-glm', reasoningEffort: 'medium' }],
                },
              ],
            },
          })
        }
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
                  env: { ...upstream.json.spec.modelConfig.env, model_id: model.name },
                  ui,
                },
              },
            },
          }),
        })
        createdIds.push(created.id)
      }
    },
    setCloudEnvironment(cloud) {
      cloudEnvironment = cloud
    },
    async verify(control) {
      const selector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
      const errors = []
      try {
        await ensureModelOptionVisible(control, 'model-option-preset-deepseek', selector, null)
        await control.command('waitFor', recommended, { visible: true })
        await control.command('waitFor', `${cloudSource} > [data-model-preset="quality"]`)
        const source = JSON.parse(await control.command('snapshot', cloudSource))
        assert.ok(!source.testIds.includes('model-option-preset-unavailable'))
        const families = JSON.parse(
          await control.command('snapshot', `${cloudSource} [data-testid="model-group-deepseek"]`)
        )
        assert.ok(families.testIds.includes('model-option-preset-deepseek'))
        assert.ok(!families.testIds.some(id => id.startsWith('model-option-preset-quality')))
        await control.command('click', recommended)

        // The default owner is second and has no explicit effort in this preset.
        await control.command('waitFor', '[data-testid="model-simple-header"]', {
          text: models[1].label,
        })
        await control.command('waitFor', '[data-testid="model-selection-mode"]', {
          text: '推荐模型集',
        })
        await control.command('waitFor', '[data-testid="model-slider-description"]', {
          text: '调整档位会切换模型及推理强度',
        })
        await control.command('press', 'body', { key: 'Escape' })
        await control.command('waitFor', selector, { text: models[1].label })
        await control.command('click', selector)

        // Start with an explicit effort, then move to both model-only positions.
        for (const model of [models[3], models[0], models[1], models[2]]) {
          const stepId = `model-power-setting-${model.name}${model.effort ? `-${model.effort}` : ''}`
          await control.command('waitFor', `[data-testid="${stepId}"]`, { visible: true })
          const label = await control.command('getAttribute', `[data-testid="${stepId}"]`, {
            value: 'aria-label',
          })
          assert.ok(label.includes(model.label), `Missing model label for ${model.name}`)
          assert.ok(
            !label.includes('undefined'),
            'Model-only steps must not render an empty effort'
          )
          await control.command('click', `[data-testid="${stepId}"]`)
          await control.command('waitFor', '[data-testid="model-simple-header"]', {
            text: model.label,
          })
          await control.command('waitFor', '[data-testid="model-selection-mode"]', {
            text: '推荐模型集',
          })
          await control.command('press', 'body', { key: 'Escape' })
          await control.command('waitFor', selector, { text: model.label })
          await control.command('click', selector)
          const slider = JSON.parse(
            await control.command('snapshot', '[data-testid="model-advanced-panel"]')
          )
          for (const target of models) {
            assert.ok(
              slider.testIds.includes(
                `model-power-setting-${target.name}${target.effort ? `-${target.effort}` : ''}`
              )
            )
          }
        }
        await control.command('click', '[data-testid="model-advanced-toggle"]')
        await control.command('click', '[data-testid="model-option-preset-long"]')
        await control.command('waitFor', '[data-testid="model-selection-mode"]', {
          text: '固定模型',
        })
        await control.command('waitFor', '[data-testid="model-slider-description"]', {
          text: '仅调整当前模型的推理强度',
        })
        assert.equal(
          (await control.command('getText', '[data-testid="model-simple-name"]')).trim(),
          models[4].label
        )
        const [menu] = JSON.parse(
          await control.command('getElementMetrics', '[data-testid="model-selector-menu"]')
        )
        for (const id of ['model-simple-name', 'model-selection-mode', 'model-simple-source']) {
          const [metrics] = JSON.parse(
            await control.command('getElementMetrics', `[data-testid="${id}"]`)
          )
          assert.ok(metrics.width > 0 && metrics.height > 0, `${id} must be visible`)
          assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${id} overflows horizontally`)
          assert.ok(metrics.scrollHeight <= metrics.clientHeight + 1, `${id} clips its text`)
          assert.ok(
            metrics.left >= menu.left && metrics.right <= menu.right,
            `${id} exceeds the menu`
          )
        }
        await captureScreenshot(control, 'model-selector-fixed-long-name.png', 'body')
        await control.command('click', '[data-testid="model-control-reasoning-high"]')
        await control.command('waitFor', '[data-testid="model-simple-name"]', {
          text: models[4].label,
        })
        await control.command('waitFor', '[data-testid="model-selection-mode"]', {
          text: '固定模型',
        })
        await control.command('click', '[data-testid="model-reset-default-button"]')
        await control.command('waitFor', '[data-testid="model-selection-mode"]', {
          text: '推荐模型集',
        })
        await control.command('waitFor', '[data-testid="model-simple-name"]', {
          text: models[1].label,
        })
        await captureScreenshot(control, 'model-selector-recommended.png', 'body')
        await control.command('click', '[data-testid="model-advanced-toggle"]')
        await control.command('click', `${cloudSource} > [data-model-preset="quality"]`)
        await control.command('press', 'body', { key: 'Escape' })
        await control.command('waitFor', selector, { text: models[3].label })
      } catch (error) {
        console.error('[cloud-model-presets] Verification failed', error)
        errors.push(error)
      } finally {
        await control.command('press', 'body', { key: 'Escape' }).catch(error => {
          console.warn('[cloud-model-presets] Could not close the model selector', error)
        })
        const cleanup = await Promise.allSettled(
          createdIds.map(async id => {
            const deleted = await fetch(
              `${cloudEnvironment.backendUrl}/api/admin/public-models/${id}`,
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${cloudEnvironment.authToken}` },
              }
            )
            assert.equal(
              deleted.status,
              204,
              'Public model cleanup must return an empty 204 response'
            )
          })
        )
        errors.push(
          ...cleanup.filter(result => result.status === 'rejected').map(result => result.reason)
        )
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Cloud preset verification or cleanup failed')
      }
    },
  }
}
