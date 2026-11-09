import { fetchLocalRuntimeJson } from '../modules/runtime-request.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { waitForSnapshot } from '../modules/conversation-layout.mjs'
import { createCodexProtocolGate } from '../modules/codex-protocol-gate.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { startModelRequestCapture } from '../modules/model-request-capture.mjs'
import { assertNativeModelContext } from '../modules/model-context-audit.mjs'
import {
  createCatalogContextVerification,
  saveCatalogAndWaitForRestart,
  waitForCatalogRestart,
} from './codex-catalog-context.mjs'

const MODEL_ID = 'gpt-5.5'
const EDIT = `[data-testid="codex-catalog-edit-openai-${MODEL_ID}"]`
const ROW = `[data-testid="codex-official-model-row-openai-${MODEL_ID}"]`
const RESTORE = `[data-testid="codex-catalog-restore-openai-${MODEL_ID}"]`

export function createDesktopScenario(options) {
  const context = createCatalogContextVerification({ ...options, modelId: MODEL_ID })
  const discoveryGate = createCodexProtocolGate(options)
  let bundledModels
  let overridePath
  let capture
  let unusedSkillBodies
  const captureDirectory = options.resultDir

  return {
    modelProviderId: 'openai',
    modelId: MODEL_ID,
    handleHttp: context.handleHttp,
    attachServer: context.attachServer,
    close: () => capture?.close(),
    async prepareApp({ appEnvironment, codexHome, control }) {
      const { stdout } = await promisify(execFile)(
        appEnvironment.CODEX_BINARY_PATH,
        ['debug', 'models', '--bundled'],
        { env: appEnvironment, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }
      )
      bundledModels = JSON.parse(stdout).models
      assert.ok(bundledModels.some(model => model.slug === MODEL_ID))
      capture = await startModelRequestCapture({ target: control.url, resultDir: captureDirectory })
      const skillRoot = new URL(
        '../../../resources/bundled-plugins/wework-personal/plugins/wework-runtime/skills/',
        import.meta.url
      )
      unusedSkillBodies = await Promise.all(
        (await readdir(skillRoot)).map(async name =>
          (await readFile(new URL(`${name}/SKILL.md`, skillRoot), 'utf8'))
            .replace(/^---[\s\S]*?---\s*/, '')
            .trim()
        )
      )
      // Reproduce the default OpenAI provider selected without a config override.
      const configPath = join(codexHome, 'config.toml')
      const config = await readFile(configPath, 'utf8')
      // Route only the model service to the fixture; keep the default provider selection.
      await writeFile(
        configPath,
        `openai_base_url = "${capture.url}/v1"\n${config.replace(/^model_provider = .*\n/m, '')}`
      )
      overridePath = join(
        appEnvironment.WEGENT_EXECUTOR_HOME,
        'capabilities',
        'model-catalog-overrides.json'
      )
      await discoveryGate.prepareApp({ appEnvironment })
    },
    async verify(control) {
      const origin = await control.command('getLocationOrigin', 'body')
      const readCatalog = async () => {
        const result = await fetchLocalRuntimeJson(control, `${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'native-catalog',
            method: 'runtime.codex.catalog.overrides.read',
            params: { slugs: bundledModels.map(model => model.slug) },
          }),
        })
        assert.equal(result.ok, true, JSON.stringify(result.error))
        return result.result.models
      }
      const entries = await readCatalog()
      for (const model of bundledModels) {
        const entry = entries.find(entry => entry.slug === model.slug)
        assert.ok(entry, `Missing native Catalog: ${model.slug}`)
        assert.deepEqual(entry.baseline, model, `Native Catalog changed: ${model.slug}`)
      }
      const baseline = entries.find(entry => entry.slug === MODEL_ID).baseline
      await control.command('navigate', 'body', { value: '/settings/personal/models' })
      await control.command('clickWhenEnabled', '[data-testid="codex-models-details-toggle"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="codex-model-provider-toggle-openai"]'
      )
      await control.command('waitFor', `${EDIT}:not(:disabled)`)
      for (const { slug } of bundledModels) {
        const selector = `[data-testid="codex-catalog-edit-openai-${slug}"]`
        if (Number(await control.command('getElementCount', selector)) > 0) {
          assert.equal(Number(await control.command('getElementCount', `${selector}:disabled`)), 0)
        }
      }
      await control.command('clickWhenEnabled', EDIT)
      await control.command('waitFor', '[data-testid="codex-catalog-editor-dialog"]')
      await control.command('fill', '[data-testid="local-model-context-window-input"]', {
        value: '300001',
      })
      const executorLogPath = join(options.resultDir, 'executor.log')
      await saveCatalogAndWaitForRestart(control, executorLogPath)
      await control.command('waitFor', ROW, { text: '已自定义' })
      const persisted = JSON.parse(await readFile(overridePath, 'utf8'))
      assert.deepEqual(persisted, [
        {
          slug: MODEL_ID,
          fields: { context_window: 300001, max_context_window: 300001 },
        },
      ])
      const saved = (await readCatalog()).find(entry => entry.slug === MODEL_ID)
      assert.deepEqual(saved.baseline, baseline)
      assert.deepEqual(saved.effective, {
        ...baseline,
        context_window: 300001,
        max_context_window: 300001,
      })
      const concurrentEntry = {
        ...saved.effective,
        display_name: 'WEWORK_E2E_CONCURRENT_CATALOG',
        context_window: 300003,
        max_context_window: 300003,
      }
      await requestExecutor(
        control,
        'runtime.codex.catalog.overrides.write',
        { slug: MODEL_ID, entry: concurrentEntry },
        options.uiTimeoutMs
      )
      await discoveryGate.verifyOverlap(control)
      const refreshed = (await readCatalog()).find(entry => entry.slug === MODEL_ID)
      assert.deepEqual(
        refreshed.effective,
        concurrentEntry,
        'The concurrent idle restart lost the new Catalog'
      )
      const discovered = await requestExecutor(
        control,
        'runtime.codex.models.list',
        { includeHidden: true },
        options.uiTimeoutMs
      )
      assert.equal(
        discovered.data.find(model => model.id === MODEL_ID)?.displayName,
        concurrentEntry.display_name,
        'The restarted real Codex did not discover the updated Catalog'
      )
      await control.command('navigate', 'body', { value: '/' })
      await control.command('navigate', 'body', { value: '/settings/personal/models' })
      await control.command('clickWhenEnabled', '[data-testid="codex-models-details-toggle"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="codex-model-provider-toggle-openai"]'
      )
      await control.command('waitFor', ROW, { text: '已自定义' })
      const restoreLogOffset = (await readFile(executorLogPath, 'utf8')).length
      await control.command('clickWhenEnabled', RESTORE)
      await waitForCatalogRestart(control, executorLogPath, restoreLogOffset)
      await waitForSnapshot(
        control,
        snapshot =>
          snapshot.testIds.includes(`codex-official-model-row-openai-${MODEL_ID}`) &&
          !snapshot.text.includes('已自定义'),
        'Restoring the native Catalog did not restore its row without customization'
      )
      const restored = (await readCatalog()).find(entry => entry.slug === MODEL_ID)
      assert.deepEqual(restored.effective, baseline)
      assert.equal(restored.overridden, false)
      assert.deepEqual(JSON.parse(await readFile(overridePath, 'utf8')), [])
      await context.verify(control, baseline.display_name)
      await context.verifyActiveRestartProtection(control)
      const requests = (await readFile(join(captureDirectory, 'model-requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
        .filter(
          body =>
            body.model === MODEL_ID && JSON.stringify(body).includes('WEWORK_CATALOG_CONTEXT_500K')
        )
      assert.ok(requests.length >= 3, 'The independent model service missed the real conversation')
      const audits = requests.map(body =>
        assertNativeModelContext(body, baseline.base_instructions, unusedSkillBodies)
      )
      await writeFile(
        join(captureDirectory, 'model-context-audit.json'),
        JSON.stringify(
          { model: MODEL_ID, mockProcessId: capture.pid, requests: requests.length, audits },
          null,
          2
        )
      )
    },
  }
}
