// @vitest-environment node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

const run = promisify(execFile)
const wework = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { compressToUTF16 } = require('lz-string')
const inventory = { entries: { account: { deviceId: 'test-device', installedPlugins: [] } } }
const compressed = `lz:${compressToUTF16(JSON.stringify(inventory))}`
let root
let bundle

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wework-client-bundle-'))
  bundle = join(root, 'shared-build', 'e2e-client')
  await run(process.execPath, [join(wework, 'scripts/build-desktop-e2e-client.mjs'), bundle], {
    cwd: wework,
  })
}, 30_000)

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

async function isolatedConsumer(name) {
  const consumer = join(root, name)
  const desktop = join(consumer, 'wework/e2e/desktop')
  await cp(join(wework, 'e2e/desktop'), desktop, { recursive: true })
  // desktop-build-flows imports the shared native tar extractor and the
  // desktop package target mapping.
  const sharedScripts = join(consumer, 'wework/scripts/lib')
  await mkdir(sharedScripts, { recursive: true })
  for (const file of ['ai-verify-devtools.mjs', 'desktop-control-queue.mjs']) {
    await cp(join(wework, 'scripts', file), join(consumer, 'wework/scripts', file))
  }
  // desktop-build-flows imports the shared native tar extractor.
  await cp(
    join(wework, 'scripts/lib/extract-runtime-archive.mjs'),
    join(sharedScripts, 'extract-runtime-archive.mjs')
  )
  await cp(
    join(wework, 'scripts/lib/desktop-package-target.mjs'),
    join(sharedScripts, 'desktop-package-target.mjs')
  )
  await cp(
    join(wework, 'scripts/lib/windows-native-runtime.mjs'),
    join(sharedScripts, 'windows-native-runtime.mjs')
  )
  const runtime = join(consumer, 'wework/electron/src/runtime')
  await mkdir(runtime, { recursive: true })
  await cp(
    join(wework, 'electron/src/runtime/release-preparation-progress.mjs'),
    join(runtime, 'release-preparation-progress.mjs')
  )
  const chatCore = join(consumer, 'packages/chat-core')
  await mkdir(join(chatCore, 'src'), { recursive: true })
  await cp(join(wework, '../packages/chat-core/package.json'), join(chatCore, 'package.json'))
  await cp(
    join(wework, '../packages/chat-core/src/runtime-user-message.js'),
    join(chatCore, 'src/runtime-user-message.js')
  )
  const client = join(consumer, '.ci-artifacts/e2e-client')
  await cp(bundle, client, { recursive: true })
  return {
    consumer,
    desktop,
    client,
    options: {
      cwd: consumer,
      env: {
        ...process.env,
        NODE_PATH: '',
        WEWORK_E2E_SOCKET_IO_CLIENT: join(client, 'socket.io-client.cjs'),
      },
    },
  }
}

test('the shared build loads plugin scenarios and decodes inventory without node_modules', async () => {
  const fixture = await isolatedConsumer('clean')
  await assert.rejects(access(join(fixture.consumer, 'node_modules')))
  await assert.rejects(access(join(fixture.consumer, 'wework/node_modules')))
  const script = `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { pathToFileURL } from 'node:url'
    assert.throws(() => createRequire(pathToFileURL(process.argv[2])).resolve('lz-string'), { code: 'MODULE_NOT_FOUND' })
    const scene = await import(pathToFileURL(process.argv[1]))
    assert.equal(typeof scene.createDesktopScenario, 'function')
    const externalAgents = await import(new URL('./collaboration-external-agents.scenario.mjs', pathToFileURL(process.argv[1])))
    assert.equal(typeof externalAgents.createDesktopScenario, 'function')
    const { decodeInventory } = await import(pathToFileURL(process.argv[2]))
    assert.deepEqual(decodeInventory(process.argv[3]), JSON.parse(process.argv[4]))
    assert.equal(typeof createRequire(import.meta.url)(process.env.WEWORK_E2E_SOCKET_IO_CLIENT).io, 'function')
  `
  await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      join(fixture.desktop, 'scenarios/plugin-uninstall-resilience.scenario.mjs'),
      join(fixture.desktop, 'modules/plugin-scope-boundaries.mjs'),
      compressed,
      JSON.stringify(Object.values(inventory.entries)),
    ],
    fixture.options
  )
}, 30_000)

test('the shared build loads renderer storage and performance recording without node_modules', async () => {
  const fixture = await isolatedConsumer('renderer-storage')
  await assert.rejects(access(join(fixture.consumer, 'node_modules')))
  await assert.rejects(access(join(fixture.consumer, 'wework/node_modules')))
  const script = `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { pathToFileURL } from 'node:url'
    assert.throws(() => createRequire(pathToFileURL(process.argv[2])).resolve('jszip'), { code: 'MODULE_NOT_FOUND' })
    const scene = await import(pathToFileURL(process.argv[1]))
    assert.equal(typeof scene.createDesktopScenario, 'function')
    const performance = await import(pathToFileURL(process.argv[2]))
    assert.equal(typeof performance.verifyPerformanceRecording, 'function')
  `
  await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      join(fixture.desktop, 'scenarios/renderer-storage.scenario.mjs'),
      join(fixture.desktop, 'modules/performance-recording.mjs'),
    ],
    fixture.options
  )
}, 30_000)

test('the shared build counts complete model requests without node_modules', async () => {
  const fixture = await isolatedConsumer('model-tokens')
  const body = { input: [{ role: 'user', content: 'hi' }], tools: [] }
  const expected = require('tiktoken').get_encoding('o200k_base')
  const tokens = expected.encode(JSON.stringify(body), [], []).length
  expected.free()
  const script = `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { pathToFileURL } from 'node:url'
    assert.throws(() => createRequire(import.meta.url).resolve('tiktoken'), { code: 'MODULE_NOT_FOUND' })
    const { countModelRequest } = await import(pathToFileURL(process.argv[1]))
    const body = JSON.parse(process.argv[2])
    assert.deepEqual(countModelRequest(body), {
      encoding: 'o200k_base', tokens: Number(process.argv[3]), bytes: Buffer.byteLength(JSON.stringify(body))
    })
    assert.ok(countModelRequest({ input: 'token '.repeat(8000) }).tokens >= 7000)
  `
  await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      join(fixture.desktop, 'modules/model-progressive-contract.mjs'),
      JSON.stringify(body),
      String(tokens),
    ],
    fixture.options
  )
}, 30_000)

test('the shared build imports the mobile scenario and executes production payload builders without node_modules', async () => {
  const fixture = await isolatedConsumer('mobile-local-payload')
  const script = `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { pathToFileURL } from 'node:url'
    assert.throws(() => createRequire(import.meta.url).resolve('vite'), { code: 'MODULE_NOT_FOUND' })
    const scene = await import(pathToFileURL(process.argv[1]))
    assert.equal(typeof scene.createDesktopScenario, 'function')
    const worktreeScene = await import(pathToFileURL(process.argv[3]))
    assert.equal(typeof worktreeScene.createDesktopScenario, 'function')
    const { loadMobileLocalPayloadBuilders } = await import(pathToFileURL(process.argv[2]))
    const builders = await loadMobileLocalPayloadBuilders()
    const provider = builders.modelInterfaceProviderId('mobile-fixture')
    const savedSelection = {
      modelName: 'task-model', modelType: 'runtime',
      options: { runnerModelProvider: provider, reasoning: 'high' }
    }
    const work = builders.adaptRuntimeWorkListResponse({ workspaces: [{
      workspacePath: '/workspace/mobile-fixture', workspaceKind: 'chat',
      tasks: [{ taskId: 'mobile-fixture-task', threadId: 'native-thread', modelSelection: savedSelection }]
    }] }, 'fixture-device')
    const [conversation] = builders.flattenConversations(work)
    assert.equal(conversation.address.threadId, 'native-thread')
    const selection = builders.modelSelectionFromRuntimeHandle(conversation.address.runtimeHandle)
    assert.deepEqual(selection, savedSelection)
    const catalog = builders.runnerModelCatalog([
      { runtime: 'codex', provider, model_id: 'task-model', local_model_id: 'task-model', label: 'Task model', supported_reasoning_efforts: ['low', 'medium', 'ultra'], default_reasoning_effort: 'medium' }
    ], [{ name: 'other-default', type: 'public', provider: 'cloud' }], 'codex')
    assert.equal(builders.findModelForSelection(catalog.map(entry => entry.model), selection)?.runtime.provider, provider)
    const selectedModel = builders.findModelForSelection(catalog.map(entry => entry.model), selection)
    assert.deepEqual(builders.reasoningEfforts(selectedModel), ['low', 'medium', 'ultra'])
    assert.equal(builders.resolvedReasoningEffort(selectedModel, undefined), 'medium')
    const transcript = builders.projectMobileRuntimeTranscript({
      taskId: 'mobile-fixture-task', workspacePath: '/workspace/mobile-fixture', runtime: 'codex', messages: [], runtimeTurns: [],
      turns: [{ id: 'turn', status: 'inProgress', items: [
        { id: 'input', type: 'user_message', message: { id: 'provider-input', clientUserMessageId: 'client-input', role: 'user', content: 'Question' } },
        { id: 'reply', type: 'assistant_text', content: 'Reply' }
      ] }]
    })
    const partial = builders.chatReducer([], { type: 'replace', messages: transcript.messages.filter(message => message.role === 'assistant') })
    const merged = builders.chatReducer(partial, { type: 'merge-latest', messages: transcript.messages })
    assert.deepEqual(merged.map(message => message.content), ['Question', 'Reply'])
    const branches = await builders.listWorkspaceBranches(async input => {
      assert.deepEqual(input, { deviceId: 'fixture-device', sourcePath: '/workspace/mobile-fixture', includeBranches: true })
      return { success: true, gitRepository: true, currentBranch: 'feature/mobile', branches: ['main', 'feature/mobile'] }
    }, { deviceId: 'fixture-device', sourcePath: '/workspace/mobile-fixture' })
    assert.deepEqual(branches, ['feature/mobile', 'main'])
    const modelConfig = builders.modelInterfaceRuntimeConfig({
      id: 'mobile-fixture', modelId: 'fixture-model', displayName: 'Fixture',
      baseUrl: 'http://127.0.0.1:9000', apiFormat: 'openai-responses'
    })
    assert.equal(modelConfig.model_provider, provider)
    assert.deepEqual(builders.resolveLocalRuntimeModelConfig({
      runtime: 'codex', modelName: 'local-model:mobile-fixture',
      modelOptions: { runnerModelProvider: provider }
    }), { model_id: 'local-model:mobile-fixture', model_provider: provider })
    const request = builders.buildLocalRuntimeExecutionRequest({
      taskId: 'mobile-fixture-task', runtime: 'codex', title: 'Mobile fixture',
      message: 'Run the real production builder', turnSeed: 1, modelConfig,
      reasoningConfig: null, localDeviceId: 'fixture-device',
      workspacePath: '/workspace/mobile-fixture', workspaceSource: 'local_path',
      newSession: true, user: { id: 1, user_name: 'fixture', email: 'fixture@example.test' }
    })
    assert.equal(request.task_id, 'mobile-fixture-task')
    assert.equal(request.prompt, 'Run the real production builder')
    assert.deepEqual(request.model_config, modelConfig)
    assert.equal(request.workspace.project.path, '/workspace/mobile-fixture')
  `
  await run(
    process.execPath,
    [
      '--no-experimental-strip-types',
      '--input-type=module',
      '-e',
      script,
      join(fixture.desktop, 'scenarios/mobile-local-payload.scenario.mjs'),
      join(fixture.desktop, 'modules/mobile-local-payload-builders.mjs'),
      join(fixture.desktop, 'scenarios/mobile-worktrees.scenario.mjs'),
    ],
    fixture.options
  )
}, 30_000)

test('a configured mobile payload artifact never falls back to source tooling', async () => {
  const fixture = await isolatedConsumer('mobile-local-payload-incomplete')
  await rm(join(fixture.client, 'mobile-local-payload.cjs'))
  await assert.rejects(
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { pathToFileURL } from 'node:url'; const { loadMobileLocalPayloadBuilders } = await import(pathToFileURL(process.argv[1])); await loadMobileLocalPayloadBuilders()",
        join(fixture.desktop, 'modules/mobile-local-payload-builders.mjs'),
      ],
      fixture.options
    ),
    error =>
      error.stderr.includes('MODULE_NOT_FOUND') && error.stderr.includes('mobile-local-payload.cjs')
  )
}, 30_000)

test('an explicitly configured incomplete artifact never falls back to workspace dependencies', async () => {
  const fixture = await isolatedConsumer('incomplete')
  await rm(join(fixture.client, 'lz-string.cjs'))
  const nodeModules = join(fixture.consumer, 'wework/node_modules')
  await mkdir(nodeModules, { recursive: true })
  await symlink(
    dirname(require.resolve('lz-string/package.json')),
    join(nodeModules, 'lz-string'),
    'junction'
  )
  await assert.rejects(
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.argv[1]))",
        join(fixture.desktop, 'modules/plugin-scope-boundaries.mjs'),
      ],
      fixture.options
    ),
    error => error.stderr.includes('MODULE_NOT_FOUND') && error.stderr.includes('lz-string.cjs')
  )
}, 30_000)
