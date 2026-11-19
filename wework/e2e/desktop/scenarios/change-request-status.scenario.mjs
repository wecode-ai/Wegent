import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'

import { delimiter, join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { waitForAttribute } from '../modules/workspace-flows.mjs'
import { selectE2EModel, runChecked, repoDir, waitForLogPattern } from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'

const execFileAsync = promisify(execFile)
const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const CHANGE_REQUEST_BUTTON = '[data-testid="change-request-button"]'
const CHANGE_REQUEST_REFRESH_INTERVAL_MS = 30_000
const ENVIRONMENT_BUTTON = '[data-testid="environment-info-button"]'
const CHANGE_REQUEST_SOURCE = {
  providerId: '@wegent/dsh-connection-git/github',
  kind: 'repository',
  transport: 'cli',
  profile: JSON.stringify(['https://github.com', '1']),
  id: '2630',
  name: 'wecode-ai/Wegent',
  monitoredObjects: [{ entityKind: 'change_request', number: 2631 }],
}
const QUERY_LOG_FILE = '.wework-change-request-e2e-queries'
const STATE_FILE = '.wework-change-request-e2e-state'
const TASK_PROMPT = 'Inspect the pull request status for this branch'
const TASK_COMPLETION = 'Pull request status fixture ready'
const FOLLOW_UP_COMPLETION = 'Pull request status follow-up ready'

async function run(command, args, cwd) {
  await execFileAsync(command, args, { cwd })
}

async function configureGitFixture(workspacePath) {
  await run('git', ['checkout', '-b', 'feature/change-request-status'], workspacePath)
  await run(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/wecode-ai/Wegent.git'],
    workspacePath
  )
}

export async function createGitHostingCliFixtures(homePath) {
  const binPath = join(homePath, '.wework-e2e-bin')
  const fixturePath = join(binPath, 'gh.mjs')
  await mkdir(binPath, { recursive: true })
  await writeFile(
    fixturePath,
    `import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
appendFileSync(join(home, '${QUERY_LOG_FILE}'), \`\${Date.now()}\\n\`)
let state = 'pending'
try {
  state = readFileSync(join(home, '${STATE_FILE}'), 'utf8').trim()
} catch {}

if (state === 'unavailable') {
  console.error('gh: command not found')
  process.exit(127)
}

const checksState =
  state === 'pending' ? 'PENDING' : state === 'failure' ? 'FAILURE' : 'SUCCESS'
const prState = state === 'merged' ? 'MERGED' : 'OPEN'
const mergedAt = state === 'merged' ? '2026-08-20T08:00:00Z' : null
const argv = process.argv.slice(2)
const args = argv.join(' ')
const endpoint = argv.find(value => value === 'user' || value === 'graphql' || value.startsWith('repos/'))
const requestUrl = 'https://github.com/wecode-ai/Wegent/pull/2631'
const headSha = 'a'.repeat(40)
const pullRequest = {
  number: 2631, url: requestUrl, title: 'feat(wework): show pull request status',
  state: prState, isDraft: false, mergedAt, headRefOid: headSha,
  updatedAt: '2026-08-20T08:00:00Z', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: { state: checksState }, mergeQueueEntry: null, timelineItems: { nodes: [] },
}
let input
if (argv.includes('--input')) {
  let body = ''
  for await (const chunk of process.stdin) body += chunk
  input = JSON.parse(body)
}

// This legacy checkpoint uses an external CLI protocol double, not real GitHub.
if (endpoint === 'user') {
  console.log(JSON.stringify({ id: 1, login: 'wework-e2e' }))
} else if (endpoint === 'repos/wecode-ai/Wegent') {
  console.log(JSON.stringify({ id: 2630, full_name: 'wecode-ai/Wegent' }))
} else if (endpoint === 'repos/wecode-ai/Wegent/pulls/2631') {
  console.log(JSON.stringify({
    number: 2631, html_url: requestUrl, title: pullRequest.title,
    state: state === 'merged' ? 'closed' : 'open', merged_at: mergedAt,
    head: { ref: 'feature/change-request-status', sha: headSha },
    base: { ref: 'main' }, updated_at: pullRequest.updatedAt,
  }))
} else if (endpoint?.includes('/comments?') || endpoint === 'repos/wecode-ai/Wegent/pulls/2631/reviews') {
  console.log('[]')
} else if (endpoint?.includes('/check-runs?')) {
  console.log(JSON.stringify({ check_runs: [] }))
} else if (endpoint === 'graphql' && input?.variables?.number === 2631) {
  console.log(JSON.stringify({ data: { repository: { pullRequest } } }))
} else if (args.includes('graphql')) {
  console.log(
    JSON.stringify({
      data: {
        repository: {
          pr0: {
            state: prState,
            isDraft: false,
            mergedAt,
            updatedAt: '2026-08-20T08:00:00Z',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: { state: checksState },
            mergeQueueEntry: null,
            timelineItems: { nodes: [] },
          },
        },
      },
    })
  )
} else if (args.includes('pulls?state=all')) {
  console.log(
    JSON.stringify([
      {
        number: 2631,
        html_url: 'https://github.com/wecode-ai/Wegent/pull/2631',
        title: 'feat(wework): show pull request status',
        state: state === 'merged' ? 'closed' : prState.toLowerCase(),
        draft: false,
        head: { ref: 'feature/change-request-status' },
        updated_at: '2026-08-20T08:00:00Z',
        merged_at: mergedAt,
      },
    ])
  )
} else if (argv[0] === 'pr' && argv[1] === 'list') {
  console.log(
    JSON.stringify([
      {
        number: 2631,
        url: 'https://github.com/wecode-ai/Wegent/pull/2631',
        title: 'feat(wework): show pull request status',
        state: prState,
        isDraft: false,
        statusCheckRollup: { state: checksState },
      },
    ])
  )
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log('Logged in to github.com as wework-e2e')
} else if (argv[0] === '--version') {
  console.log('gh version 2.0.0 (protocol fixture)')
} else {
  console.error('Unsupported GitHub protocol fixture request: ' + (endpoint ?? argv[0]))
  process.exit(64)
}
`
  )
  if (process.platform !== 'win32') {
    const executablePath = join(binPath, 'gh')
    await writeFile(executablePath, '#!/bin/sh\nexec node "$(dirname "$0")/gh.mjs" "$@"\n')
    await chmod(executablePath, 0o755)
  }
  await writeFile(
    join(binPath, 'glab.mjs'),
    `import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
assert.deepEqual(args.slice(0, 2), ['auth', 'login'])
if (args.includes('--help')) {
  console.log('--hostname --git-protocol --stdin --insecure-storage')
} else {
  assert.equal(args[args.indexOf('--hostname') + 1], 'git.example.test')
  assert.ok(args.includes('--stdin'))
  let token = ''
  for await (const chunk of process.stdin) token += chunk
  assert.equal(token.trim(), 'synthetic-desktop-e2e-gitlab-token')
  const directory = process.env.GLAB_CONFIG_DIR
  assert.ok(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, 'config.yml'), 'hosts:\\n  git.example.test:\\n    token: ' + token.trim() + '\\n', { mode: 0o600 })
}
`
  )
  if (process.platform !== 'win32') {
    const gitLabPath = join(binPath, 'glab')
    await writeFile(gitLabPath, '#!/bin/sh\nexec node "$(dirname "$0")/glab.mjs" "$@"\n')
    await chmod(gitLabPath, 0o755)
  }
  if (process.platform === 'win32') {
    // Rust CreateProcess resolves native executables, not the legacy shell's .cmd shim.
    const executable = join(binPath, 'gh.exe')
    const prepared = process.env.WEWORK_E2E_NODE_CLI_PROTOCOL_BIN
    if (prepared) await copyFile(prepared, executable)
    else {
      await runChecked('rustc', [
        fileURLToPath(new URL('../fixtures/node-cli-protocol.rs', import.meta.url)),
        '--edition',
        '2021',
        '-o',
        executable,
      ])
    }
    await copyFile(executable, join(binPath, 'glab.exe'))
  }
  process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ''}`
  if (process.platform === 'win32') return {}
  // Keep the CLI fixture ahead of developer tools after login-shell hydration.
  const nodePath = join(binPath, 'node')
  await symlink(process.execPath, nodePath)
  return { WEWORK_NODE_PATH: nodePath }
}

async function createLocalProject(control, workspacePath, timeoutMs) {
  await control.command('waitFor', '[data-testid="project-work-button"]', { timeoutMs })
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', { timeoutMs })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', { timeoutMs })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'change-request-e2e',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'change-request-e2e',
    timeoutMs,
  })
}

function writeTaskCompletion(response, requestCount) {
  const responseId = `wework-change-request-e2e-${requestCount}`
  const completion = requestCount === 1 ? TASK_COMPLETION : FOLLOW_UP_COMPLETION
  const events = [
    {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.done',
      item: {
        id: `wework-change-request-e2e-message-${requestCount}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: completion, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
          total_tokens: 2,
        },
      },
    },
  ]
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  response.end(
    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  )
}

async function queryTimestamps(path) {
  const contents = await readFile(path, 'utf8')
  return contents
    .split('\n')
    .filter(Boolean)
    .map(value => Number(value))
    .filter(Number.isFinite)
}

async function refreshEnvironment(control) {
  await control.command('click', ENVIRONMENT_BUTTON)
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="environment-info-popover"]')),
    0,
    'The environment summary did not close before refresh'
  )
  await control.command('click', ENVIRONMENT_BUTTON)
  await control.command('waitFor', '[data-testid="environment-info-popover"]')
}

async function readNativeUiObservers(journalPath) {
  try {
    const database = new DatabaseSync(journalPath, { readOnly: true })
    try {
      // Match the native event store's lock budget during concurrent WAL recovery.
      database.exec('PRAGMA busy_timeout = 250')
      return database
        .prepare("SELECT id,value FROM records WHERE section='observers'")
        .all()
        .map(({ id, value }) => {
          const observer = JSON.parse(value)
          assert.ok(observer && typeof observer === 'object' && observer.id === id)
          return observer
        })
    } finally {
      database.close()
    }
  } catch (error) {
    // Keep diagnostic codes without exposing journal contents or native error text.
    throw Object.assign(new Error('The native change-request observer journal could not be read'), {
      code: error.code,
      sqliteCode: error.errcode,
    })
  }
}

function hasChangeRequestSource(observer) {
  return Object.entries(CHANGE_REQUEST_SOURCE).every(([key, value]) =>
    isDeepStrictEqual(observer.source?.[key], value)
  )
}

function newChangeRequestObserverPredicate(before) {
  const devices = new Set(before.filter(hasChangeRequestSource).map(observer => observer.device_id))
  assert.equal(devices.size, 1, 'The target observation must belong to one native Runtime')
  const [deviceId] = devices
  assert.ok(typeof deviceId === 'string' && deviceId)
  const identityFields = ['id', 'consumer_key', 'generation']
  const previousIdentities = identityFields.map(field => new Set(before.map(row => row[field])))
  return observers =>
    observers.filter(
      observer =>
        hasChangeRequestSource(observer) &&
        observer.device_id === deviceId &&
        identityFields.every(
          (field, index) =>
            typeof observer[field] === 'string' &&
            observer[field].length > 0 &&
            !previousIdentities[index].has(observer[field])
        ) &&
        observer.consumer_key.startsWith('change-request-ui:') &&
        observer.status === 'observing' &&
        Number.isSafeInteger(observer.expires_at) &&
        observer.expires_at > Date.now()
    ).length === 1
}

export async function prepareChangeRequestRecovery(executorHome) {
  const journalPath = join(executorHome, 'runtime-work', 'conversation-event-subscriptions.sqlite')
  return {
    journalPath,
    activationCompleted: newChangeRequestObserverPredicate(
      await readNativeUiObservers(journalPath)
    ),
  }
}

export async function recoverChangeRequestStatus(
  control,
  { statePath, uiTimeoutMs, journalPath, activationCompleted }
) {
  // Repair the provider before re-enabling its observer. Start may return cached facts.
  await writeFile(statePath, 'merged\n')
  await control.command('click', '[data-testid="change-request-status-switch"]')
  await waitForAttribute(
    control,
    '[data-testid="change-request-status-switch"]',
    'aria-checked',
    'true',
    'Re-enabling PR/MR status lookup was not persisted'
  )
  await until(
    () => readNativeUiObservers(journalPath),
    activationCompleted,
    'The target native change-request observer did not finish its new activation',
    uiTimeoutMs
  )
  // Only now open the summary: its forced refresh has the original UI step budget.
  await control.command('click', '[data-testid="settings-back-button"]')
  await control.command('waitFor', ENVIRONMENT_BUTTON, { timeoutMs: uiTimeoutMs })
  await control.command('click', ENVIRONMENT_BUTTON)
  await control.command('waitFor', '[data-testid="environment-info-popover"]')

  await control.command('waitFor', CHANGE_REQUEST_BUTTON, { text: '#2631' })
  await control.command('waitFor', CHANGE_REQUEST_BUTTON, { text: '已合并' })
  assert.match(
    await control.command('getAttribute', CHANGE_REQUEST_BUTTON, { value: 'aria-label' }),
    /已合并/,
    'The recovered PR control did not expose its merged status'
  )
  await control.command('waitFor', '[data-testid="change-request-checks"]', { text: '检查通过' })
  await control.command('click', '[data-testid="environment-change-request-status"]')
  await control.command(
    'waitFor',
    '[data-testid="environment-change-request-status-popover"] [data-testid="resource-observation-status"]',
    { text: '状态同步正常' }
  )
}

export async function createDesktopScenario({
  captureScreenshot,
  executorHome,
  homePath,
  resultDir,
  uiTimeoutMs,
  workspacePath,
}) {
  await configureGitFixture(workspacePath)
  const appEnvironment = await createGitHostingCliFixtures(homePath)

  const queryLogPath = join(homePath, QUERY_LOG_FILE)
  const statePath = join(homePath, STATE_FILE)
  const gitSyncRequests = []
  let modelRequestCount = 0
  let cloud
  let executorBinary
  let proxy
  await writeFile(queryLogPath, '')
  await writeFile(statePath, 'pending\n')
  const capture = (control, name, selector = ACTIVE_WORKBENCH_SELECTOR) =>
    captureScreenshot(control, name, selector)

  return {
    externalServiceProtocols: ['git-hosting'],
    appEnvironment,
    setExecutorBinary(binary) {
      executorBinary = binary
    },
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async prepareCloud({ backendUrl }) {
      proxy = await new TransportFaultProxy(backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      proxy.rule = (entry, request) => {
        if (
          entry.method !== 'PUT' ||
          entry.path !== '/api/devices/desktop-e2e-git-target/git-accounts'
        )
          return null
        const chunks = []
        request.on('data', chunk => chunks.push(chunk))
        request.once('end', () =>
          gitSyncRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        )
        return null
      }
    },
    async cleanup() {
      await proxy?.stop()
    },

    async handleHttp(request, response, url) {
      if (request.method === 'POST' && url.pathname === '/v1/responses') {
        for await (const _chunk of request) {
          // Consume the request before returning the deterministic response.
        }
        modelRequestCount += 1
        writeTaskCompletion(response, modelRequestCount)
        return true
      }
      return false
    },

    async verify(control) {
      cloud.executorBinary = executorBinary
      await Promise.all([
        cloud.startGeneratedRemoteDevice({
          deviceId: 'desktop-e2e-git-target',
          deviceName: 'Git Sync Remote',
        }),
        cloud.startGeneratedRemoteDevice({
          deviceId: 'desktop-e2e-busy-cloud',
          deviceName: 'Busy Cloud',
          deviceType: 'cloud',
        }),
      ])
      await runChecked(
        'uv',
        [
          'run',
          'python',
          '-c',
          'from app.db.session import SessionLocal; from app.models.user import User; from shared.utils.crypto import encrypt_git_token; db=SessionLocal(); user=db.get(User,1); user.git_info=[{"id":"desktop-e2e-git-account","git_domain":"git.example.test","type":"gitlab","git_login":"desktop-e2e-user","git_email":"desktop-e2e@example.test","git_token":encrypt_git_token("synthetic-desktop-e2e-gitlab-token")}]; db.commit(); db.close()',
        ],
        { cwd: join(repoDir, 'backend'), env: cloud.backendEnv }
      )
      await createLocalProject(control, workspacePath, uiTimeoutMs)
      await selectE2EModel(control, undefined, undefined, ACTIVE_WORKBENCH_SELECTOR)
      const executorLogPath = join(resultDir, 'executor.log')
      const observerLogOffset = (await readFile(executorLogPath, 'utf8')).length
      const monitorRegistrationWindowStartedAt = Date.now()
      await control.command('fill', '[data-testid="chat-message-input"]', {
        value: TASK_PROMPT,
      })
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: TASK_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      const { workbench } = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const summary = await requestExecutor(
        control,
        'runtime.tasks.get',
        { address: workbench.currentRuntimeTask },
        uiTimeoutMs
      )
      assert.equal(summary.success, true)
      assert.equal(summary.task.gitInfo.currentBranch, 'feature/change-request-status')
      assert.equal(summary.task.gitInfo.originUrl, 'https://github.com/wecode-ai/Wegent.git')
      await control.command('waitFor', ENVIRONMENT_BUTTON, { timeoutMs: uiTimeoutMs })
      if (
        Number(
          await control.command('getElementCount', '[data-testid="environment-info-popover"]')
        ) === 0
      ) {
        await control.command('click', ENVIRONMENT_BUTTON)
      }
      await control.command('waitFor', '[data-testid="environment-info-popover"]')
      await capture(control, 'change-request-status-01-task-created.png')

      await control.command('waitFor', CHANGE_REQUEST_BUTTON, {
        text: '#2631',
        timeoutMs: 4_000,
      })
      await control.command('waitFor', '[data-testid="change-request-checks"]', {
        text: '检查中',
      })
      await control.command('waitFor', '[data-testid^="runtime-local-task-change-request-"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.match(
        await control.command(
          'getAttribute',
          '[data-testid^="runtime-local-task-change-request-"]',
          { value: 'aria-label' }
        ),
        /#2631.*检查中/,
        'The runtime task sidebar did not reuse the pull request status'
      )
      assert.match(
        await control.command('getText', CHANGE_REQUEST_BUTTON),
        /feat\(wework\): show pull request status/
      )
      await capture(control, 'change-request-status-02-pending.png')

      // Branch discovery can render before the first shared observer has finished collecting.
      // Establish the baseline only after that original activation has completed.
      const observerLog = await waitForLogPattern(
        executorLogPath,
        /app IPC request finished .*command_key=connection_observer_start .*ok=true/,
        { fromOffset: observerLogOffset, timeoutMs: uiTimeoutMs }
      )
      const countObserverStarts = log =>
        [
          ...log
            .slice(observerLogOffset)
            .matchAll(/app IPC request started .*command_key=connection_observer_start/g),
        ].length
      assert.equal(
        countObserverStarts(observerLog),
        1,
        'The first visible PR/MR resource started more than one shared observer'
      )
      const scheduledRefreshCutoff =
        monitorRegistrationWindowStartedAt + CHANGE_REQUEST_REFRESH_INTERVAL_MS
      assert.ok(
        Date.now() < scheduledRefreshCutoff,
        'The first shared observation did not settle before the scheduled refresh'
      )
      const initialQueries = (await queryTimestamps(queryLogPath)).filter(
        timestamp => timestamp < scheduledRefreshCutoff
      )
      assert.ok(initialQueries.length > 0, 'The initial PR/MR lookup did not invoke GitHub CLI')
      await control.command('click', ENVIRONMENT_BUTTON)
      await control.command('fill', '[data-testid="chat-message-input"]', {
        value: 'Keep the current task active without changing its branch',
      })
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: FOLLOW_UP_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.ok(
        Date.now() < scheduledRefreshCutoff,
        'The equivalent refresh was not observed before the scheduled refresh'
      )
      assert.equal(
        (await queryTimestamps(queryLogPath)).filter(
          timestamp => timestamp < scheduledRefreshCutoff
        ).length,
        initialQueries.length,
        'An equivalent runtime task refresh repeated the PR/MR lookup'
      )
      assert.equal(
        countObserverStarts(await readFile(executorLogPath, 'utf8')),
        1,
        'An equivalent runtime task refresh restarted the shared PR/MR observer'
      )
      await control.command('click', ENVIRONMENT_BUTTON)
      await control.command('waitFor', '[data-testid="environment-info-popover"]')

      await writeFile(statePath, 'failure\n')
      await refreshEnvironment(control)
      await control.command('waitFor', '[data-testid="change-request-checks"]', {
        text: '检查失败',
      })
      await control.command('click', ENVIRONMENT_BUTTON)
      await control.command('click', '[data-testid^="runtime-local-task-change-request-"]')
      await control.command(
        'waitFor',
        '[data-testid^="runtime-local-task-change-request-"][data-testid$="-popover"]'
      )
      await capture(control, 'change-request-status-02b-failed-repair-action.png', 'body')
      await control.command(
        'click',
        '[data-testid^="runtime-local-task-change-request-"][data-testid$="-repair"]'
      )
      await control.command('waitFor', '[data-testid="user-message-content"]', {
        text: '修复 PR/MR #2631',
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'change-request-status-03-repair-user-message.png')
      await control.command('click', ENVIRONMENT_BUTTON)
      await control.command('waitFor', '[data-testid="environment-info-popover"]')

      await writeFile(statePath, 'success\n')
      await refreshEnvironment(control)
      await control.command('waitFor', '[data-testid="change-request-checks"]', {
        text: '检查通过',
      })
      await control.command('click', '[data-testid="environment-change-request-status"]')
      await control.command(
        'waitFor',
        '[data-testid="environment-change-request-status-popover"]',
        { text: '检查通过' }
      )
      await control.command(
        'waitFor',
        '[data-testid="environment-change-request-status-popover"] [data-testid="resource-observation-status"]',
        { text: '状态同步正常' }
      )
      await capture(control, 'change-request-status-04-checks-passed.png')
      const recovery = await prepareChangeRequestRecovery(executorHome)
      await control.command('click', '[data-testid="environment-change-request-status"]')

      await writeFile(statePath, 'unavailable\n')
      await refreshEnvironment(control)
      await control.command('waitFor', '[data-testid="change-request-lookup-hint"]', {
        text: '安装 GitHub CLI',
      })
      await control.command('waitFor', CHANGE_REQUEST_BUTTON, { text: '#2631' })
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="create-pull-request-button"]')
        ),
        0,
        'A collection failure must retain the known PR rather than suggest creating a duplicate'
      )
      await capture(control, 'change-request-status-05-cli-unavailable.png')

      await control.command('click', '[data-testid="change-request-open-settings"]')
      await control.command('waitFor', '[data-testid="git-hosting-settings-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="git-hosting-cli-github-status"]', {
        // The unavailable fixture exits 127; a CLI execution failure is not missing auth.
        text: '检测失败',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getAttribute', '[data-testid="change-request-status-switch"]', {
          value: 'aria-checked',
        }),
        'true',
        'PR/MR status lookup should be enabled by default'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="git-device-sync-section"]')),
        0,
        'Device Git configuration should not remain under Git hosting settings'
      )
      await runChecked(
        'uv',
        [
          'run',
          'python',
          '-c',
          `import asyncio
from app.services.device_service import DeviceService
async def mark_busy():
    online = await DeviceService.get_device_online_info(1, "desktop-e2e-busy-cloud")
    assert online
    changed = await DeviceService.update_device_status_in_redis(
        1, "desktop-e2e-busy-cloud", "busy", socket_id=online["socket_id"]
    )
    assert changed
asyncio.run(mark_busy())`,
        ],
        { cwd: join(repoDir, 'backend'), env: cloud.backendEnv }
      )
      await capture(control, 'change-request-status-06-settings-enabled.png', 'body')
      await control.command('click', '[data-testid="settings-nav-connections"]')
      await control.command('waitFor', '[data-testid="cloud-connection-status-card"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="git-device-sync-accounts"]', {
        text: 'gitlab · git.example.test',
        timeoutMs: uiTimeoutMs,
      })
      const eligibleTargetCount = await until(
        async () =>
          Number(
            await control.command(
              'getElementCount',
              '[data-testid="git-device-sync-select"] option[value="desktop-e2e-git-target"]'
            )
          ),
        count => count === 1,
        'The eligible remote Git sync target did not finish loading',
        uiTimeoutMs
      )
      assert.equal(
        eligibleTargetCount,
        1,
        'The eligible remote device was not available as a Git sync target'
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            '[data-testid="git-device-sync-select"] option[value="desktop-e2e-busy-cloud"]'
          )
        ),
        0,
        'A busy cloud device was offered as a Git sync target'
      )
      await control.command('select', '[data-testid="git-device-sync-select"]', {
        value: 'desktop-e2e-git-target',
      })
      await control.command('clickWhenEnabled', '[data-testid="git-device-sync-submit"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="git-device-sync-result"]', {
        text: '已同步 1 个域',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="git-device-sync-terminal-hint"]', {
        text: '打开新终端',
        timeoutMs: uiTimeoutMs,
      })
      assert.deepEqual(
        gitSyncRequests,
        [{ allow_empty: false }],
        'Git credentials were not synced exactly once to the explicitly selected device'
      )
      await control.command('scrollIntoView', '[data-testid="git-device-sync-result"]')
      await capture(control, 'change-request-status-06b-device-sync-result.png', 'body')

      await control.command('click', '[data-testid="settings-nav-git-hosting"]')
      await control.command('waitFor', '[data-testid="git-hosting-settings-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="change-request-status-switch"]')
      await waitForAttribute(
        control,
        '[data-testid="change-request-status-switch"]',
        'aria-checked',
        'false',
        'Disabling PR/MR status lookup was not persisted'
      )
      await control.command('click', '[data-testid="settings-nav-general"]')
      await control.command('click', '[data-testid="settings-nav-git-hosting"]')
      await control.command('waitFor', '[data-testid="git-hosting-settings-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await waitForAttribute(
        control,
        '[data-testid="change-request-status-switch"]',
        'aria-checked',
        'false',
        'Disabled PR/MR status lookup should remain disabled after reopening settings'
      )
      await control.command('waitFor', '[data-testid="git-hosting-cli-github-status"]', {
        text: '检测失败',
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'change-request-status-07-settings-disabled.png', 'body')

      await recoverChangeRequestStatus(control, { statePath, uiTimeoutMs, ...recovery })
      await capture(control, 'change-request-status-08-recovered-merged.png')
      await control.command('click', '[data-testid="environment-change-request-status"]')
    },

    diagnostics() {
      return { changeRequestState: statePath, gitSyncRequestCount: gitSyncRequests.length }
    },
  }
}
