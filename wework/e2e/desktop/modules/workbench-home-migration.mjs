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

import { CHECKPOINT_TASK_PROMPT } from './shared.mjs'
import { verifyNativeMcpEnvironment } from './native-mcp-environment.mjs'
import { verifyNativeAgentMcp } from './native-agent-mcp.mjs'
import {
  packagedResourcesRoot,
  verifyWorkbenchSchemaCompatibility,
} from './workbench-schema-compatibility.mjs'

const CONFIG_MARKER = 'WEWORK_E2E_WORKBENCH_HOME_CONFIG'
const SESSION_PATH = join('sessions', 'workbench-home-e2e', 'session.marker')
const ATTACHMENT_PATH = join('workspace', 'attachments', 'workbench-home-e2e.bin')
const ATTACHMENT = Buffer.from([0, 1, 2, 127, 128, 254, 255])
const NATIVE_SESSION_MARKER = 'WEWORK_MIGRATION_NATIVE_HISTORY_42'

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
  const execution = promisify(execFile)(fixture.codexBinary, args, {
    cwd: fixture.workspace,
    env: { ...fixture.environment, CODEX_HOME: home, WEGENT_CODEX_HOME: home },
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  execution.child.stdin.end()
  const { stdout } = await execution
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

async function readPackagedNamespace(appBinary, environment) {
  const resourcesRoot = packagedResourcesRoot(appBinary)
  // Electron's filesystem reads the package metadata inside the actual app.asar.
  const script =
    "const fs = require('node:fs'); " +
    "const metadata = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); " +
    "process.stdout.write(JSON.stringify(metadata.weworkExecutorNamespace?.trim() || ''))"
  const { stdout } = await promisify(execFile)(
    appBinary,
    ['-e', script, join(resourcesRoot, 'app.asar', 'package.json')],
    { env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000 }
  )
  const namespace = JSON.parse(stdout)
  assert.equal(typeof namespace, 'string')
  if (namespace) assert.match(namespace, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  return namespace
}

async function requestExecutor(control, method, timeoutMs) {
  const origin = await control.command('getLocationOrigin', 'body')
  const response = await fetch(`${origin}/wework/executor/v1/rpc`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ id: `workbench-home-${method}`, method, params: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  assert.equal(response.ok, true, `${method} returned HTTP ${response.status}`)
  const payload = await response.json()
  assert.equal(payload.ok, true, `${method} failed: ${payload.error?.message}`)
  return payload.result
}

export function createWorkbenchHomeMigrationScenario({
  homePath,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let fixture
  let restartDesktopApp
  const completed = []

  async function assertActiveHome(control, expectedHome) {
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

  async function assertMigrated(control) {
    const source = await lstat(fixture.sourceHome)
    const target = await stat(fixture.targetHome, { bigint: true })
    assert.equal(source.isSymbolicLink(), true, 'Legacy entry must point to the relocated Home')
    assert.equal((await lstat(fixture.targetHome)).isDirectory(), true)
    assert.equal(await readlink(fixture.sourceHome), fixture.targetHome)
    assert.equal(await realpath(fixture.sourceHome), fixture.targetHome)
    assert.equal(target.isDirectory(), true)
    assert.equal(target.dev, fixture.sourceDevice, 'Migration must stay on the same filesystem')
    assert.equal(target.ino, fixture.sourceInode, 'Migration must preserve the original directory')
    const auth = join(fixture.targetHome, 'auth.json')
    assert.equal((await lstat(auth)).isSymbolicLink(), true)
    assert.equal(await realpath(auth), fixture.authPath)
    assert.equal((await stat(auth, { bigint: true })).ino, fixture.authInode)
    await assertSeed(fixture.targetHome)
    await assertSeed(fixture.sourceHome)
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
    assert.equal(await realpath(fixture.capabilitiesSource), fixture.capabilitiesTarget)
    await assertAbsent(join(fixture.targetHome, ATTACHMENT_PATH))
    const journal = JSON.parse(await readFile(fixture.journalPath, 'utf8'))
    assert.equal(journal.version, 1)
    assert.equal(journal.strategy, undefined)
    assert.equal(journal.sourceHome, fixture.sourceHome)
    assert.equal(journal.targetHome, fixture.targetHome)
    assert.equal(journal.device, (fixture.journalDevice ?? fixture.sourceDevice).toString())
    assert.equal(journal.inode, fixture.sourceInode.toString())
    assert.match(journal.token, /^[0-9a-f-]{36}$/)
    const database = join(fixture.desktopRoot, 'data', 'tasks.sqlite')
    assert.equal(await realpath(fixture.legacyDatabase), database)
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT value FROM migration_probe').get().value, 'before-upgrade')
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    } finally {
      db.close()
    }
    assert.equal(
      await readFile(join(fixture.desktopRoot, 'credentials', 'migration-marker'), 'utf8'),
      'synthetic-key-marker'
    )
    await assertActiveHome(control, fixture.targetHome)
    return journal
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
        USERPROFILE: home,
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
      const defaultExecutorHome = namespace
        ? join(home, '.wework', 'apps', namespace)
        : join(home, '.wework')
      const sourceHome = join(defaultExecutorHome, 'codex')
      const attachmentPath = join(defaultExecutorHome, ATTACHMENT_PATH)
      const workbenchRoot = join(home, '.wegent', 'workbench')
      const desktopRoot = join(workbenchRoot, 'wework', namespace || 'default')
      for (const path of [sourceHome, workbenchRoot]) {
        assertWithin(home, path)
        await assertAbsent(path)
      }
      await mkdir(join(sourceHome, dirname(SESSION_PATH)), { recursive: true })
      await mkdir(dirname(attachmentPath), { recursive: true })
      // Only use the runner's synthetic config and authentication, never a personal Home.
      assert.equal((await lstat(join(seedCodexHome, 'config.toml'))).isFile(), true)
      await copyFile(join(seedCodexHome, 'config.toml'), join(sourceHome, 'config.toml'))
      const configPath = join(sourceHome, 'config.toml')
      const seedConfig = await readFile(configPath, 'utf8')
      assert.ok(!seedConfig.includes('mcp_oauth_credentials_store'))
      await writeFile(
        configPath,
        `${seedConfig}\n[mcp_servers.migration-http]\nurl = "https://example.invalid/mcp"\nenabled = false\n`
      )
      const authPath = join(seedCodexHome, 'auth.json')
      const auth = await lstat(authPath, { bigint: true })
      assert.equal(auth.isFile(), true)
      await symlink(relative(sourceHome, authPath), join(sourceHome, 'auth.json'))
      // This marker verifies file preservation, not native Codex session resumption.
      const session = `${JSON.stringify({
        marker: 'WEWORK_E2E_WORKBENCH_HOME_SESSION',
        attachmentPath,
      })}\n`
      await writeFile(join(sourceHome, SESSION_PATH), session)
      await writeFile(attachmentPath, ATTACHMENT)
      const capabilitiesSource = join(defaultExecutorHome, 'capabilities')
      await mkdir(join(capabilitiesSource, 'store', 'migration-fixture'), { recursive: true })
      const skill =
        '---\nname: migration-fixture\ndescription: Synthetic migration fixture.\n---\nNo actions.\n'
      await writeFile(join(capabilitiesSource, 'store', 'migration-fixture', 'SKILL.md'), skill)
      await mkdir(join(sourceHome, 'skills'), { recursive: true })
      await symlink(
        '../../capabilities/store/migration-fixture',
        join(sourceHome, 'skills', 'migration-fixture'),
        'dir'
      )
      const legacyDatabase = join(defaultExecutorHome, 'data', 'tasks.sqlite')
      await mkdir(dirname(legacyDatabase), { recursive: true })
      const database = new DatabaseSync(legacyDatabase)
      try {
        database.exec(
          "CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES ('before-upgrade')"
        )
      } finally {
        database.close()
      }
      await mkdir(join(defaultExecutorHome, 'credentials'), { recursive: true })
      await writeFile(
        join(defaultExecutorHome, 'credentials', 'migration-marker'),
        'synthetic-key-marker'
      )
      const workspace = join(home, 'native-migration-workspace')
      await mkdir(workspace)
      const attachment = await lstat(attachmentPath, { bigint: true })
      const source = await lstat(sourceHome, { bigint: true })
      fixture = {
        namespace: namespace || 'default',
        desktopRoot,
        legacyDatabase,
        sourceHome,
        targetHome: join(desktopRoot, 'codex'),
        journalPath: join(
          desktopRoot,
          'migrations',
          'codex-home-v1',
          'workbench-home-migration.json'
        ),
        sourceDevice: source.dev,
        sourceInode: source.ino,
        authPath,
        authInode: auth.ino,
        attachmentPath,
        attachmentDevice: attachment.dev,
        attachmentInode: attachment.ino,
        session,
        skill,
        capabilitiesSource,
        capabilitiesTarget: join(desktopRoot, 'capabilities'),
        codexBinary: appEnvironment.CODEX_BINARY_PATH,
        environment: { ...appEnvironment },
        workspace,
      }
      assert.equal(typeof fixture.codexBinary, 'string')
      fixture.nativeMcpEnvironment = await verifyNativeMcpEnvironment({ fixture, resultDir })
      completed.push('native-mcp-service-environment-start-resume')
      fixture.nativeAgentMcp = await verifyNativeAgentMcp({ fixture, resultDir })
      completed.push('native-agent-mcp-persistence-and-followup')
      fixture.nativeAgentMcpOverride = await verifyNativeAgentMcp({
        fixture,
        resultDir,
        explicitWorkbench: true,
      })
      completed.push('native-agent-workbench-override-and-single-agent-config')
      control.setScenario('checkpoint_task')
      fixture.nativeThread = await runNativeTurn(fixture, sourceHome)
      completed.push('native-session-before-upgrade')
      appEnvironment.WEGENT_EXECUTOR_HOME = defaultExecutorHome
    },

    setRestartDesktopApp(value) {
      restartDesktopApp = value
    },

    async verify(control) {
      assert.ok(fixture, 'Workbench Home fixture was not prepared before Electron startup')
      assert.equal(typeof restartDesktopApp, 'function')
      const journal = await assertMigrated(control)
      completed.push('migrated')
      await runNativeTurn(fixture, fixture.targetHome, fixture.nativeThread)
      const resumedRequest = control.scenarioRequests.get('checkpoint_task')?.at(-1)
      assert.ok(
        JSON.stringify(resumedRequest?.body).includes(NATIVE_SESSION_MARKER),
        'Native resume lost pre-upgrade conversation history'
      )
      completed.push('native-session-resumed-after-upgrade')
      // Simulate the persisted device number becoming stale after a volume remount.
      fixture.journalDevice = fixture.sourceDevice + 1n
      journal.device = fixture.journalDevice.toString()
      await writeFile(fixture.journalPath, JSON.stringify(journal))
      const bridge = await lstat(fixture.sourceHome, { bigint: true })
      const journalContents = await readFile(fixture.journalPath, 'utf8')
      const journalMetadata = await lstat(fixture.journalPath, { bigint: true })

      await restartDesktopApp()
      assert.deepEqual(await assertMigrated(control), journal)
      assert.equal((await lstat(fixture.sourceHome, { bigint: true })).ino, bridge.ino)
      assert.equal(await readFile(fixture.journalPath, 'utf8'), journalContents)
      const restartedJournal = await lstat(fixture.journalPath, { bigint: true })
      assert.equal(restartedJournal.ino, journalMetadata.ino)
      assert.equal(restartedJournal.mtimeNs, journalMetadata.mtimeNs)
      completed.push('idempotent-restart')
      completed.push('completed-migration-survives-device-number-change')
      // Same native binary through the legacy entry: session continuity, not old-binary downgrade.
      await runNativeTurn(fixture, fixture.sourceHome, fixture.nativeThread)
      const legacyEntryRequest = control.scenarioRequests.get('checkpoint_task')?.at(-1)
      assert.ok(
        JSON.stringify(legacyEntryRequest?.body).includes(NATIVE_SESSION_MARKER),
        'Legacy Home lost native conversation history'
      )
      completed.push('legacy-entry-session-continuity')
      control.setScenario('initial')
      await writeFile(
        join(resultDir, 'workbench-home-migration.json'),
        `${JSON.stringify(
          {
            namespace: fixture.namespace,
            completed,
            journal,
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
