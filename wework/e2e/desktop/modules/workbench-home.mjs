import { fetchLocalRuntime } from './runtime-request.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

import { CHECKPOINT_TASK_PROMPT, MODEL_API_KEY, MODEL_PROVIDER_ID } from './shared.mjs'
import { verifyNativeMcpEnvironment } from './native-mcp-environment.mjs'
import { verifyNativeAgentMcp } from './native-agent-mcp.mjs'
import { collectCodexSqliteDiagnostics } from './codex-sqlite-diagnostics.mjs'
import { readPackagedNamespace } from './packaged-resources.mjs'
import { verifyWorkbenchSchemaCompatibility } from './workbench-schema-compatibility.mjs'

const CONFIG_MARKER = 'WEWORK_E2E_WORKBENCH_HOME_CONFIG'
const SESSION_PATH = join('sessions', 'workbench-home-e2e', 'session.marker')
const ATTACHMENT_PATH = join('workspace', 'attachments', 'workbench-home-e2e.bin')
const ATTACHMENT = Buffer.from([0, 1, 2, 127, 128, 254, 255])
const NATIVE_SESSION_MARKER = 'WEWORK_MIGRATION_NATIVE_HISTORY_42'

async function recordNativeTurnFailure(fixture, home, resumeId, error, stdout) {
  try {
    const configPath = join(home, 'config.toml')
    const [configResult, homeResult] = await Promise.allSettled([
      readFile(configPath, 'utf8'),
      realpath(home),
    ])
    const config = configResult.status === 'fulfilled' ? configResult.value : ''
    const diagnostic = {
      home,
      configPath,
      resolvedHome: homeResult.status === 'fulfilled' ? homeResult.value : undefined,
      homeError: homeResult.status === 'rejected' ? homeResult.reason.message : undefined,
      configError: configResult.status === 'rejected' ? configResult.reason.message : undefined,
      configBytes: Buffer.byteLength(config),
      providerSection: config
        .split('\n')
        .filter(line => line.includes('model_providers') && line.trim().startsWith('[')),
      selectedProvider: config.match(/^model_provider\s*=\s*(.+)$/m)?.[1],
      configMarkerPresent: config.includes(CONFIG_MARKER),
      resumeId,
      code: error.code,
      message: error.message,
      stdout: stdout ?? error.stdout,
      stderr: error.stderr,
      sqlite: await collectCodexSqliteDiagnostics(home, resumeId),
    }
    await writeFile(
      join(fixture.resultDir, 'native-migration-turn-failure.json'),
      JSON.stringify(diagnostic)
    )
    console.error('[native-migration-resume]', JSON.stringify(diagnostic))
  } catch (diagnosticError) {
    // Observability must not replace the native execution or validation failure.
    console.error('Native migration diagnostics failed:', diagnosticError.message)
  }
}

async function runNativeTurn(fixture, home, resumeId) {
  const args = resumeId
    ? [
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        resumeId,
        `${CHECKPOINT_TASK_PROMPT} follow-up`,
      ]
    : [
        'exec',
        '--json',
        '--skip-git-repo-check',
        `${CHECKPOINT_TASK_PROMPT} ${NATIVE_SESSION_MARKER}`,
      ]
  // Upgrade changes the persisted provider identity. Native CLI probes must use
  // that identity too, while still addressing only the fixture model service.
  const provider = resumeId ? '~' : MODEL_PROVIDER_ID
  args.push('-c', `model_provider=${JSON.stringify(provider)}`)
  if (resumeId) {
    const profile = {
      name: 'Workbench migration fixture',
      base_url: `http://127.0.0.1:${process.env.WEWORK_E2E_MODEL_SERVER_PORT}/v1`,
      experimental_bearer_token: MODEL_API_KEY,
      wire_api: 'responses',
      requires_openai_auth: false,
    }
    args.push(
      '-c',
      `model_providers.${provider}={${Object.entries(profile)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(',')}}`
    )
  }
  const execution = promisify(execFile)(fixture.codexBinary, args, {
    cwd: fixture.workspace,
    env: {
      ...fixture.environment,
      CODEX_HOME: home,
      WEGENT_CODEX_HOME: home,
      RUST_LOG: 'error,codex_rollout::state_db=warn,codex_state=warn',
    },
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  execution.child.stdin.end()
  let stdout
  try {
    stdout = (await execution).stdout
    const events = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
    const thread = events.find(event => event.type === 'thread.started')?.thread_id
    assert.equal(typeof thread, 'string', 'Native Codex did not report its persisted thread')
    assert.ok(
      events.some(event => event.type === 'turn.completed'),
      'Native Codex turn did not finish'
    )
    if (resumeId)
      assert.equal(thread, resumeId, 'Native Codex created a new session instead of resuming')
    return thread
  } catch (error) {
    await recordNativeTurnFailure(fixture, home, resumeId, error, stdout)
    throw error
  }
}

function assertWithin(root, path) {
  const suffix = relative(root, path)
  assert.ok(
    suffix && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`),
    `Workbench Home fixture must stay inside the isolated result directory: ${path}`
  )
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' }, `Unexpected migration artifact: ${path}`)
}

async function requestExecutor(control, method, timeoutMs) {
  const origin = await control.command('getLocationOrigin', 'body')
  const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ id: `workbench-home-${method}`, method, params: {} }),
    timeoutMs: timeoutMs,
  })
  assert.equal(response.ok, true, `${method} returned HTTP ${response.status}`)
  const payload = await response.json()
  assert.equal(payload.ok, true, `${method} failed: ${payload.error?.message}`)
  return payload.result
}

export function createWorkbenchHomeScenario({
  homePath,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let fixture
  let restartDesktopApp
  const completed = []

  async function assertActiveHome(control, expectedHome) {
    // Startup catalog reconciliation can restart Codex and close its SQLite files.
    // Finish that lifecycle change before probing the same Home with a native CLI.
    await control.command('ensureLocalModelCatalogReady', 'body', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    const config = await requestExecutor(control, 'executor.codex_home.config.read', uiTimeoutMs)
    assert.equal(resolve(config.codexHome), expectedHome, 'Executor selected the wrong Codex Home')
    assert.equal(resolve(config.configPath), join(expectedHome, 'config.toml'))
    assert.equal(config.remoteAppsEnabled, false, 'Executor did not read the seeded config')
    const startup = await requestExecutor(
      control,
      'runtime.codex.ensure_started',
      workbenchReadyTimeoutMs
    )
    assert.equal(startup.ready, true, 'Real Codex did not start with the selected Home')
  }

  async function assertSeed(home) {
    assert.ok((await readFile(join(home, 'config.toml'), 'utf8')).includes(CONFIG_MARKER))
    assert.equal(await readFile(join(home, SESSION_PATH), 'utf8'), fixture.session)
  }

  async function assertCurrentHome(control) {
    const target = await lstat(fixture.targetHome, { bigint: true })
    assert.equal(target.isDirectory(), true)
    assert.equal(target.dev, fixture.sourceDevice)
    assert.equal(target.ino, fixture.sourceInode, 'Startup must use the existing Workbench Home')
    assert.equal(await readlink(fixture.oldExecutorHome), fixture.disconnectedVolume)
    await assertAbsent(fixture.disconnectedVolume)
    await assertAbsent(join(fixture.desktopRoot, 'migrations', 'codex-home-v1'))
    const auth = join(fixture.targetHome, 'auth.json')
    assert.equal((await lstat(auth)).isSymbolicLink(), true)
    assert.equal(await realpath(auth), fixture.authPath)
    assert.equal((await stat(auth, { bigint: true })).ino, fixture.authInode)
    await assertSeed(fixture.targetHome)
    const session = JSON.parse(await readFile(join(fixture.targetHome, SESSION_PATH), 'utf8'))
    assert.equal(session.attachmentPath, fixture.attachmentPath)
    assert.equal(await realpath(session.attachmentPath), fixture.attachmentPath)
    const attachment = await lstat(session.attachmentPath, { bigint: true })
    assert.equal(attachment.isFile(), true, 'The attachment must remain at its original path')
    assert.equal(attachment.dev, fixture.attachmentDevice)
    assert.equal(
      attachment.ino,
      fixture.attachmentInode,
      'The attachment must not be moved or copied'
    )
    assert.deepEqual(await readFile(session.attachmentPath), ATTACHMENT)
    assert.equal(
      await readFile(join(fixture.targetHome, 'skills', 'migration-fixture', 'SKILL.md'), 'utf8'),
      fixture.skill
    )
    const database = join(fixture.desktopRoot, 'data', 'tasks.sqlite')
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      // The executor still writes this live database while migration is inspected.
      db.exec('PRAGMA busy_timeout = 10000')
      assert.equal(db.prepare('SELECT value FROM migration_probe').get().value, 'before-startup')
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    } finally {
      db.close()
    }
    assert.equal(
      await readFile(join(fixture.desktopRoot, 'credentials', 'migration-marker'), 'utf8'),
      'synthetic-key-marker'
    )
    await assertActiveHome(control, fixture.targetHome)
  }

  return {
    codexConfigToml: `# ${CONFIG_MARKER}\n[features]\napps = false\n`,

    async prepareApp({ appBinary, appEnvironment, codexHome, control }) {
      await verifyWorkbenchSchemaCompatibility({ appBinary, appEnvironment, resultDir })
      completed.push('executor-schema-compatibility')
      const root = await realpath(resultDir)
      const home = await realpath(homePath)
      const seedCodexHome = await realpath(codexHome)
      assertWithin(root, home)
      assertWithin(root, seedCodexHome)
      Object.assign(appEnvironment, {
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        WEWORK_E2E_NATIVE_CODEX_HOME: join(home, '.codex'),
        WEGENT_CODEX_HOME: undefined,
        WEGENT_WORKBENCH_HOME: undefined,
        WEGENT_CAPABILITIES_HOME: undefined,
        WEGENT_CLAUDE_HOME: undefined,
        CLAUDE_CONFIG_DIR: undefined,
        CODEX_SQLITE_HOME: undefined,
      })
      const namespace = await readPackagedNamespace(appBinary, appEnvironment)
      const oldExecutorHome = namespace
        ? join(home, '.wework', 'apps', namespace)
        : join(home, '.wework')
      const workbenchRoot = join(home, '.wegent', 'workbench')
      const desktopRoot = join(workbenchRoot, 'wework', namespace || 'default')
      const targetHome = join(desktopRoot, 'codex')
      const attachmentPath = join(desktopRoot, ATTACHMENT_PATH)
      const disconnectedVolume = join(home, 'unmounted-executor-volume')
      await mkdir(dirname(oldExecutorHome), { recursive: true })
      await symlink(disconnectedVolume, oldExecutorHome, 'junction')
      for (const path of [targetHome, workbenchRoot]) {
        assertWithin(home, path)
        await assertAbsent(path)
      }
      await mkdir(join(targetHome, dirname(SESSION_PATH)), { recursive: true })
      await mkdir(dirname(attachmentPath), { recursive: true })
      // Only use the runner's synthetic config and authentication, never a personal Home.
      assert.equal((await lstat(join(seedCodexHome, 'config.toml'))).isFile(), true)
      await copyFile(join(seedCodexHome, 'config.toml'), join(targetHome, 'config.toml'))
      const configPath = join(targetHome, 'config.toml')
      const seedConfig = await readFile(configPath, 'utf8')
      assert.ok(!seedConfig.includes('mcp_oauth_credentials_store'))
      await writeFile(
        configPath,
        `${seedConfig}\n[mcp_servers.migration-http]\nurl = "https://example.invalid/mcp"\nenabled = false\n`
      )
      const authPath = join(seedCodexHome, 'auth.json')
      const auth = await lstat(authPath, { bigint: true })
      assert.equal(auth.isFile(), true)
      await symlink(relative(targetHome, authPath), join(targetHome, 'auth.json'))
      // This marker verifies file preservation, not native Codex session resumption.
      const session = `${JSON.stringify({
        marker: 'WEWORK_E2E_WORKBENCH_HOME_SESSION',
        attachmentPath,
      })}\n`
      await writeFile(join(targetHome, SESSION_PATH), session)
      await writeFile(attachmentPath, ATTACHMENT)
      const capabilitiesSource = join(desktopRoot, 'capabilities')
      await mkdir(join(capabilitiesSource, 'store', 'migration-fixture'), { recursive: true })
      const skill =
        '---\nname: migration-fixture\ndescription: Synthetic migration fixture.\n---\nNo actions.\n'
      await writeFile(join(capabilitiesSource, 'store', 'migration-fixture', 'SKILL.md'), skill)
      await mkdir(join(targetHome, 'skills'), { recursive: true })
      await symlink(
        '../../capabilities/store/migration-fixture',
        join(targetHome, 'skills', 'migration-fixture'),
        'dir'
      )
      const databasePath = join(desktopRoot, 'data', 'tasks.sqlite')
      await mkdir(dirname(databasePath), { recursive: true })
      const database = new DatabaseSync(databasePath)
      try {
        database.exec(
          "CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES ('before-startup')"
        )
      } finally {
        database.close()
      }
      await mkdir(join(desktopRoot, 'credentials'), { recursive: true })
      await writeFile(join(desktopRoot, 'credentials', 'migration-marker'), 'synthetic-key-marker')
      const workspace = join(home, 'native-migration-workspace')
      await mkdir(workspace)
      const attachment = await lstat(attachmentPath, { bigint: true })
      const source = await lstat(targetHome, { bigint: true })
      fixture = {
        resultDir,
        namespace: namespace || 'default',
        desktopRoot,
        oldExecutorHome,
        disconnectedVolume,
        targetHome,
        sourceDevice: source.dev,
        sourceInode: source.ino,
        authPath,
        authInode: auth.ino,
        attachmentPath,
        attachmentDevice: attachment.dev,
        attachmentInode: attachment.ino,
        session,
        skill,
        codexBinary: appEnvironment.CODEX_BINARY_PATH,
        environment: { ...appEnvironment },
        workspace,
      }
      assert.equal(typeof fixture.codexBinary, 'string')
      fixture.nativeMcpEnvironment = await verifyNativeMcpEnvironment({ fixture, resultDir })
      completed.push('native-mcp-service-environment-start-resume')
      fixture.nativeAgentMcp = await verifyNativeAgentMcp({ fixture, resultDir })
      completed.push('native-agent-mcp-persistence-and-followup')
      fixture.emptyCommandHttpMcp = await verifyNativeAgentMcp({
        fixture,
        resultDir,
        emptyCommandHttp: true,
      })
      completed.push('native-agent-empty-command-http-mcp-start-and-resume')
      fixture.nativeAgentMcpOverride = await verifyNativeAgentMcp({
        fixture,
        resultDir,
        explicitWorkbench: true,
      })
      completed.push('native-agent-workbench-override-and-single-agent-config')
      control.setScenario('checkpoint_task')
      fixture.nativeThread = await runNativeTurn(fixture, targetHome)
      completed.push('native-session-before-startup')
      delete appEnvironment.WEGENT_EXECUTOR_HOME
    },

    setRestartDesktopApp(value) {
      restartDesktopApp = value
    },

    async verify(control) {
      assert.ok(fixture, 'Workbench Home fixture was not prepared before Electron startup')
      assert.equal(typeof restartDesktopApp, 'function')
      await assertCurrentHome(control)
      completed.push('opened-current-home')
      await runNativeTurn(fixture, fixture.targetHome, fixture.nativeThread)
      const resumedRequest = control.scenarioRequests.get('checkpoint_task')?.at(-1)
      assert.ok(
        JSON.stringify(resumedRequest?.body).includes(NATIVE_SESSION_MARKER),
        'Native resume lost pre-startup conversation history'
      )
      completed.push('native-session-resumed-after-startup')

      // Use the real Codex executable as an incompatible Executor, as in the
      // packaged schema checks. The model service remains the only test double.
      await restartDesktopApp({
        appEnvironmentOverrides: { WEWORK_EXECUTOR_PATH: fixture.codexBinary },
      })
      await control.command('navigate', 'body', { value: '/settings' })
      await control.command('waitFor', '[data-testid="general-settings-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      const degradedOrigin = await control.command('getLocationOrigin', 'body')
      const degraded = await fetchLocalRuntime(control, `${degradedOrigin}/wework/executor/v1`, {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(degraded.status, 503, 'The unavailable Executor must fail at its own API')
      assert.equal((await degraded.json()).error.code, 'runtime_not_ready')
      completed.push('workbench-settings-open-with-incompatible-executor')

      await restartDesktopApp({
        appEnvironmentOverrides: { WEWORK_EXECUTOR_PATH: fixture.environment.WEWORK_EXECUTOR_PATH },
      })
      await assertCurrentHome(control)
      completed.push('idempotent-restart')
      control.setScenario('initial')
      await writeFile(
        join(resultDir, 'workbench-home.json'),
        `${JSON.stringify(
          {
            namespace: fixture.namespace,
            completed,
            nativeThread: fixture.nativeThread,
            nativeMcpEnvironment: fixture.nativeMcpEnvironment,
            nativeAgentMcp: fixture.nativeAgentMcp,
            attachment: {
              path: fixture.attachmentPath,
              device: fixture.attachmentDevice.toString(),
              inode: fixture.attachmentInode.toString(),
            },
          },
          null,
          2
        )}\n`
      )
    },

    diagnostics() {
      return { namespace: fixture?.namespace, completed }
    },
  }
}
