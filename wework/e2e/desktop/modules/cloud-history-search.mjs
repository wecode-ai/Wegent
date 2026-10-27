import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'

import { TransportFaultProxy } from './transport-fault-proxy.mjs'
import { createCachedHistoryTask, verifyCachedHistorySearch } from './cached-history-search.mjs'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import {
  TERMINAL_HISTORY_SEARCH_CASES,
  TERMINAL_HISTORY_TURN_COUNT as TURN_COUNT,
  assertAsyncHistoryUnloaded,
  seedNativeTerminalHistory,
  terminalHistoryAssistantEvents,
  terminalHistoryCompletion,
  terminalHistoryTurn,
  terminalHistoryUserText,
  verifyNativeTerminalHistorySearch,
  verifyTerminalHistorySearch,
  waitForHighlightedHistoryMatch,
} from './terminal-history-search.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_DEVICE_ID,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_PUBLIC_MODEL_OPTIONS,
  DEFAULT_STEP_TIMEOUT_MS,
  FRESH_CHAT_PROMPT,
  WORKBENCH_READY_TIMEOUT_MS,
  resultDir,
  stopProcessGroup,
} from './shared.mjs'

const SEARCH_PATH = '/api/runtime-work/transcript/search'
const TRANSCRIPT_PATH = '/api/runtime-work/transcript'
const QUERY = 'CLOUD_HISTORY_SEARCH_TARGET'
const MATCH_TURNS = [10, 30]
const FIND = '[data-testid="conversation-find-input"]'
const FIND_RETRY = '[data-testid="conversation-find-retry"]'
const COUNT =
  '[data-testid="conversation-find-bar"]:has([data-testid="conversation-find-input"]:not([aria-busy="true"])) [data-testid="conversation-find-count"]'
const OLDER = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
const NEWER = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-newer-runtime-transcript-button"]`
const USERS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="user-message-content"]`
const ANSWERS = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`
const prompt = index =>
  terminalHistoryUserText(
    index,
    MATCH_TURNS.includes(index) ? `${QUERY} ${index}` : `Cloud history question ${index}`
  )
const answer = index => `Cloud history answer ${index}`

/** Buffer only the two bounded read APIs; forward their original bytes exactly once. */
class HistorySearchFaultProxy extends TransportFaultProxy {
  async forward(request, response) {
    const path = new URL(request.url, this.target).pathname
    if (request.method !== 'POST' || ![SEARCH_PATH, TRANSCRIPT_PATH].includes(path)) {
      super.forward(request, response)
      return
    }
    try {
      const chunks = []
      let length = 0
      for await (const chunk of request) {
        length += chunk.length
        assert.ok(length <= 1024 * 1024, 'History read request exceeded the fixture limit')
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      const body = JSON.parse(bytes.toString('utf8'))
      const replay = Readable.from([bytes])
      Object.assign(replay, {
        url: request.url,
        headers: request.headers,
        method: request.method,
        historySearch: {
          taskId: body.taskId,
          projectSession: body.projectSession,
          query: body.query,
          beforeCursor: body.beforeCursor,
          afterCursor: body.afterCursor,
          limit: body.limit,
        },
      })
      super.forward(replay, response)
    } catch {
      response.destroy()
    }
  }
}

async function findRollout(directory, threadId) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const match = await findRollout(path, threadId)
      if (match) return match
    } else if (entry.name.endsWith(`${threadId}.jsonl`)) return path
  }
  return null
}

async function seedHistory(cloud, taskId, nativeTaskId) {
  // Stop the real Executor before editing its isolated persisted fixture.
  await stopProcessGroup(cloud.remoteExecutor)
  await cloud.waitForDeviceStatus(CLOUD_DEVICE_ID, 'offline', cloud.remoteExecutorLogPath)
  const indexPath = join(dirname(cloud.remoteCodexHome), 'runtime-work', 'index.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const task = Object.values(index.tasks ?? {}).find(value => value.local_task_id === taskId)
  assert.ok(task?.thread_id, 'The cloud fixture did not persist its real Codex thread')
  const path = await findRollout(join(cloud.remoteCodexHome, 'sessions'), task.thread_id)
  assert.ok(path, 'The cloud fixture did not create a real Codex rollout')
  const records = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const metadata = records.find(record => record.type === 'session_meta')
  assert.ok(metadata?.payload, 'The cloud rollout has no session metadata')
  metadata.payload.history_mode = 'legacy'
  for (let index = 0; index < TURN_COUNT; index += 1) {
    const turnId = `cloud-search-turn-${index}`
    const terminal = terminalHistoryTurn(index)
    const text = terminal?.text ?? answer(index)
    const assistantEvents = terminalHistoryAssistantEvents(index, text, turnId)
    for (const payload of [
      { type: 'task_started', turn_id: turnId, model_context_window: null },
      { type: 'user_message', message: prompt(index), text_elements: [], local_images: [] },
      ...assistantEvents,
      terminalHistoryCompletion(turnId, assistantEvents.at(-1).message, terminal),
    ]) {
      records.push({ timestamp: '2026-10-20T00:00:00Z', type: 'event_msg', payload })
    }
  }
  await writeFile(path, `${records.map(value => JSON.stringify(value)).join('\n')}\n`)
  const database = new DatabaseSync(join(cloud.remoteCodexHome, 'state_5.sqlite'))
  try {
    const changed = database
      .prepare("UPDATE threads SET history_mode = 'legacy' WHERE id = ?")
      .run(task.thread_id)
    assert.equal(Number(changed.changes), 1, 'The cloud Codex thread metadata was not updated')
  } finally {
    database.close()
  }
  delete task.runtime_handle?.completedTranscriptMessages
  delete task.runtime_handle?.completedTranscriptThreadId
  const cachedTask = createCachedHistoryTask(task)
  index.tasks[cachedTask.local_task_id] = cachedTask
  const nativeTask = Object.values(index.tasks).find(value => value.local_task_id === nativeTaskId)
  assert.ok(nativeTask?.thread_id, 'The native cloud fixture has no completed Codex thread')
  seedNativeTerminalHistory(cloud.remoteCodexHome, nativeTask.thread_id)
  delete nativeTask.runtime_handle?.completedTranscriptMessages
  delete nativeTask.runtime_handle?.completedTranscriptThreadId
  await writeFile(indexPath, `${JSON.stringify(index)}\n`)
  await cloud.restartCloudExecutor()
  return { cachedTask, legacyThreadId: task.thread_id, nativeThreadId: nativeTask.thread_id }
}

async function waitForPane(control, predicate, description, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let pane
  do {
    pane = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).pane
    if (predicate(pane)) return pane
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(`${description}: ${JSON.stringify(pane?.transcript)}`)
}

async function openBoundTaskConversation(control, projectId, issueId, bindingId) {
  await control.command('openWeworkScheme', 'body', {
    value: `wework://boards/${projectId}/issues/${issueId}`,
  })
  // Scheme delivery is asynchronous; retained tabs must not satisfy these clicks.
  const activeTab = '[data-workspace-tab-content][aria-hidden="false"]'
  await control.command(
    'clickWhenEnabled',
    `${activeTab} [data-testid="cloud-todo-open-task-conversation-${bindingId}"]`,
    { visible: true, timeoutMs: WORKBENCH_READY_TIMEOUT_MS }
  )
  await control.command(
    'clickWhenEnabled',
    `${activeTab} [data-testid="ai-chat-open-runtime-task"]`,
    { visible: true }
  )
}

/** Runs inside the existing CI cloud conversation-state checkpoint. */
export function createCloudHistorySearchVerification() {
  let proxy
  let scope
  let taskId
  let cachedTaskId
  let nativeTaskId
  let fault
  const evidence = []
  const appEnvironment = {}

  return {
    appEnvironment,
    async prepareCloud(cloud) {
      proxy = await new HistorySearchFaultProxy(cloud.backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      proxy.rule = (entry, request) => {
        const read = request.historySearch
        if (!read || ![taskId, cachedTaskId, nativeTaskId].includes(read.taskId)) return null
        const bound =
          read.projectSession?.projectId === scope?.projectId &&
          read.projectSession?.issueId === scope?.issueId
        // Keep only fixture identities and stages, never bodies, cursors, or credentials.
        entry.projectBound = bound
        entry.cachedHistory = read.taskId === cachedTaskId
        entry.nativeHistory = read.taskId === nativeTaskId
        entry.stage = entry.path === SEARCH_PATH ? 'search' : read.afterCursor ? 'after' : 'before'
        if (!bound || !fault?.matches(entry, read)) return null
        const selected = fault
        fault = undefined
        selected.request = entry
        return 'drop-response'
      }
    },
    async verify({ cloudEnvironment: cloud, control, restartDesktopApp, workspacePath }) {
      const request = async (path, body, token = cloud.authToken, expectedStatus) => {
        const response = await fetch(`${cloud.backendUrl}${path}`, {
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        })
        const text = await response.text()
        if (expectedStatus !== undefined) {
          assert.equal(response.status, expectedStatus, `${path}: ${text}`)
          return null
        }
        assert.ok(response.ok, `${path}: HTTP ${response.status}: ${text}`)
        return text ? JSON.parse(text) : null
      }
      try {
        control.setScenario('fresh_chat')
        const createTask = title =>
          request('/api/runtime-work/create', {
            deviceId: CLOUD_DEVICE_ID,
            workspacePath,
            runtime: 'codex',
            message: FRESH_CHAT_PROMPT,
            title,
            modelId: CLOUD_PUBLIC_MODEL_NAME,
            modelType: 'public',
            modelOptions: CLOUD_PUBLIC_MODEL_OPTIONS,
            modelSelection: {
              modelName: CLOUD_PUBLIC_MODEL_NAME,
              modelType: 'public',
              options: CLOUD_PUBLIC_MODEL_OPTIONS,
            },
          })
        const created = await createTask('Project-bound cloud history search')
        assert.equal(created.accepted, true)
        taskId = created.taskId
        assert.ok(taskId)
        const address = { deviceId: created.deviceId, taskId, workspacePath: created.workspacePath }
        await cloud.waitForRuntimeTask(address)
        const nativeCreated = await createTask('Project-bound native history search')
        assert.equal(nativeCreated.accepted, true)
        nativeTaskId = nativeCreated.taskId
        await cloud.waitForRuntimeTask({ ...address, taskId: nativeTaskId })
        const { cachedTask, legacyThreadId, nativeThreadId } = await seedHistory(
          cloud,
          taskId,
          nativeTaskId
        )
        const nativeAddress = { ...address, taskId: nativeTaskId, threadId: nativeThreadId }
        cachedTaskId = cachedTask.local_task_id

        await request('/api/admin/setup-complete', {})
        const workspace = await request('/api/v1/workspaces', {
          name: `Cloud search ${process.pid}`,
        })
        const project = await request(`/api/v1/workspaces/${workspace.id}/projects`, {
          name: 'Cloud history search',
          project_key: 'CLOUDSEARCH',
          task_provider: 'local',
          visibility: 'private',
        })
        const issuePath = `/api/v1/cloud-projects/${project.id}/loop-items`
        const issue = await request(issuePath, { title: 'Find old cloud messages' })
        const otherIssue = await request(issuePath, {
          title: 'Unbound cloud session must be denied',
        })
        scope = { projectId: String(project.id), issueId: issue.id }
        await request(`/api/v1/loop-items/${issue.id}/tasks`, {
          ...address,
          taskTitle: 'Project-bound cloud history search',
          executionContext: { runtime: 'codex', workspacePath, threadId: legacyThreadId },
        })
        const bindings = await request(`/api/v1/loop-items/${issue.id}/tasks`)
        assert.equal(bindings.length, 1)
        assert.equal(bindings[0].task_id, taskId)

        const search = { ...address, projectSession: scope, query: QUERY }
        const results = await request(SEARCH_PATH, search)
        assert.equal(results.totalMatches, 2)
        assert.deepEqual(
          results.matches.map(match => match.turnId),
          MATCH_TURNS.map(index => `cloud-search-turn-${index}`)
        )
        for (const { query, matches } of TERMINAL_HISTORY_SEARCH_CASES) {
          const terminal = await request(SEARCH_PATH, { ...search, query })
          assert.equal(terminal.totalMatches, matches.length, `Cloud contract query: ${query}`)
          assert.deepEqual(
            terminal.matches.map(match => match.turnId),
            matches.map(match => `cloud-search-turn-${match.index}`),
            'Cloud search indexed a hidden terminal body or omitted useful output'
          )
        }
        await request(
          SEARCH_PATH,
          { ...search, projectSession: { ...scope, issueId: otherIssue.id } },
          cloud.authToken,
          404
        )
        const userName = `cloud-search-outsider-${process.pid}`
        const password = 'cloud-history-search-e2e-only'
        await request('/api/admin/users', {
          user_name: userName,
          password,
          role: 'user',
          auth_source: 'password',
        })
        const login = await request('/api/auth/login', { user_name: userName, password })
        await request(SEARCH_PATH, search, login.access_token, 404)
        evidence.push({ authorization: 'wrong-binding and non-member rejected with 404' })

        await restartDesktopApp()
        await ensureExperimentalFeaturesEnabled(control)
        await openBoundTaskConversation(control, project.id, issue.id, bindings[0].id)
        await waitForPane(
          control,
          pane => pane?.currentRuntimeTask?.taskId === taskId && !pane.transcript.loading,
          'The bound cloud task did not open',
          WORKBENCH_READY_TIMEOUT_MS
        )
        await control.command('waitFor', OLDER)
        await control.command('waitFor', ANSWERS, { text: answer(TURN_COUNT - 1) })
        const original = await waitForPane(
          control,
          pane => pane?.currentRuntimeTask?.taskId === taskId && !pane.transcript.loading,
          'The original cloud conversation did not finish loading'
        )
        await assertAsyncHistoryUnloaded(control)
        assert.doesNotMatch(
          await control.command('getText', ANSWERS),
          /interrupted|TERMINAL_ERROR_BODY/
        )
        const arm = (name, matches) => {
          assert.equal(fault, undefined, 'A previous cloud search fault was not consumed')
          const next = { name, matches }
          fault = next
          return next
        }
        const assertFault = selected => {
          assert.ok(
            selected.request?.committedResponseDropped,
            `${selected.name} did not reach the real Backend`
          )
          assert.equal(
            selected.request.status,
            200,
            `${selected.name} did not complete a real read`
          )
          evidence.push({ stage: selected.name, ...selected.request })
        }
        const assertRecovered = async (count, index) => {
          await control.command('waitFor', COUNT, { text: count })
          assert.equal(Number(await control.command('getElementCount', FIND_RETRY)), 0)
          await waitForHighlightedHistoryMatch(control, prompt(index))
        }
        // Focus an existing pane button; Issue-owned executions have no composer.
        await control.command('nativePress', OLDER, {
          key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
        })
        const searchFault = arm('search', entry => entry.path === SEARCH_PATH)
        await control.command('fill', FIND, { value: QUERY })
        await control.command('waitFor', FIND_RETRY)
        await control.command('waitFor', FIND_RETRY, { text: '搜索失败' })
        assertFault(searchFault)
        await control.command('clickWhenEnabled', FIND_RETRY)
        await assertRecovered('1 / 2', MATCH_TURNS[0])

        const hydrationFault = arm(
          'match hydration',
          (entry, read) =>
            entry.path === TRANSCRIPT_PATH &&
            read.beforeCursor === results.matches[1].cursor &&
            read.limit === 5
        )
        await control.command('clickWhenEnabled', '[data-testid="conversation-find-next-button"]')
        await control.command('waitFor', FIND_RETRY)
        await control.command('waitFor', FIND_RETRY, { text: '历史加载失败' })
        assertFault(hydrationFault)
        await control.command('clickWhenEnabled', FIND_RETRY)
        await assertRecovered('2 / 2', MATCH_TURNS[1])

        const contextFault = arm(
          'context pagination',
          (entry, read) =>
            entry.path === TRANSCRIPT_PATH &&
            Boolean(read.beforeCursor) &&
            read.beforeCursor !== results.matches[1].cursor &&
            read.limit === 5
        )
        await control.command('scrollIntoView', OLDER)
        await control.command('clickWhenEnabled', OLDER)
        const error = `${ACTIVE_WORKBENCH_SELECTOR} [role="alert"]`
        await control.command('waitFor', error, { text: '历史加载失败' })
        assertFault(contextFault)
        // Clicking the same retained cursor is the explicit context retry.
        await control.command('clickWhenEnabled', OLDER)
        await control.command('waitFor', error, { visible: false })
        await control.command('waitFor', USERS, { text: prompt(MATCH_TURNS[1] - 2) })
        await control.command('waitFor', USERS, { text: prompt(MATCH_TURNS[1]) })
        assert.equal(Number(await control.command('getElementCount', FIND_RETRY)), 0)
        await control.command('scrollIntoView', NEWER)
        await control.command('clickWhenEnabled', NEWER)
        await control.command('waitFor', USERS, { text: prompt(MATCH_TURNS[1] + 2) })
        await verifyTerminalHistorySearch(control, DEFAULT_STEP_TIMEOUT_MS, prompt)
        await control.command('fill', FIND, { value: `${QUERY}_NO_MATCH` })
        await control.command('waitFor', COUNT, { text: '0 个结果' })
        assert.equal(Number(await control.command('getElementCount', FIND_RETRY)), 0)
        await control.command('nativePress', FIND, { key: 'Escape' })
        await control.command('waitFor', ANSWERS, { text: answer(TURN_COUNT - 1) })
        const restored = await waitForPane(
          control,
          pane => pane?.currentRuntimeTask?.taskId === taskId && !pane.transcript.loading,
          'The original cloud conversation was not restored'
        )
        for (const field of ['hasMoreBefore', 'loadingMoreBefore', 'loadedRanges']) {
          assert.deepEqual(
            restored.transcript[field],
            original.transcript[field],
            `Search changed original cloud pagination: ${field}`
          )
        }
        assert.deepEqual(
          restored.messageSummary,
          original.messageSummary,
          'Cloud search polluted original messages'
        )
        assert.equal(Number(await control.command('getElementCount', NEWER)), 0)
        await assertAsyncHistoryUnloaded(control)
        assert.ok(
          proxy.requests.filter(
            entry =>
              entry.path === SEARCH_PATH &&
              entry.projectBound &&
              !entry.fault &&
              entry.status === 200
          ).length >= 2,
          'The UI did not use the real project-bound cloud search route'
        )
        const cachedAddress = { ...address, taskId: cachedTask.local_task_id }
        await cloud.waitForRuntimeTask(cachedAddress)
        await request(`/api/v1/loop-items/${issue.id}/tasks`, {
          ...cachedAddress,
          taskTitle: cachedTask.title,
          executionContext: {
            runtime: cachedTask.runtime,
            workspacePath,
            threadId: cachedTask.thread_id,
          },
        })
        const cachedBinding = (await request(`/api/v1/loop-items/${issue.id}/tasks`)).find(
          binding => binding.task_id === cachedTask.local_task_id
        )
        assert.ok(cachedBinding, 'The cached cloud history task was not bound to the Issue')
        await openBoundTaskConversation(control, project.id, issue.id, cachedBinding.id)
        await waitForPane(
          control,
          pane =>
            pane?.currentRuntimeTask?.taskId === cachedTask.local_task_id &&
            !pane.transcript.loading,
          'The cached cloud history task did not open',
          WORKBENCH_READY_TIMEOUT_MS
        )
        await verifyCachedHistorySearch(control, query =>
          request(SEARCH_PATH, { ...cachedAddress, projectSession: scope, query })
        )
        const cachedReads = proxy.requests.filter(
          entry => entry.cachedHistory && entry.projectBound && entry.status === 200
        )
        assert.ok(
          cachedReads.filter(entry => entry.path === SEARCH_PATH).length >= 3 &&
            cachedReads.some(entry => entry.path === TRANSCRIPT_PATH && entry.stage === 'before'),
          'Cached matches must load through the real project-bound cloud routes'
        )
        evidence.push({
          cachedHistory: 'project-bound search, terminal visibility and restoration',
        })
        await request(`/api/v1/loop-items/${issue.id}/tasks`, {
          ...nativeAddress,
          taskTitle: 'Project-bound native history search',
          executionContext: { runtime: 'codex', workspacePath, threadId: nativeThreadId },
        })
        const nativeBinding = (await request(`/api/v1/loop-items/${issue.id}/tasks`)).find(
          binding => binding.task_id === nativeTaskId
        )
        assert.ok(nativeBinding, 'The native cloud history task was not bound to the Issue')
        await openBoundTaskConversation(control, project.id, issue.id, nativeBinding.id)
        await waitForPane(
          control,
          pane => pane?.currentRuntimeTask?.taskId === nativeTaskId && !pane.transcript.loading,
          'The native cloud history task did not open',
          WORKBENCH_READY_TIMEOUT_MS
        )
        await verifyNativeTerminalHistorySearch(
          control,
          nativeAddress,
          DEFAULT_STEP_TIMEOUT_MS,
          query => request(SEARCH_PATH, { ...nativeAddress, projectSession: scope, query })
        )
        const nativeReads = proxy.requests.filter(
          entry => entry.nativeHistory && entry.projectBound && entry.status === 200
        )
        assert.ok(
          nativeReads.some(entry => entry.path === SEARCH_PATH) &&
            nativeReads.some(entry => entry.path === TRANSCRIPT_PATH && entry.stage === 'before'),
          'Native matches must load through the real project-bound cloud routes'
        )
        evidence.push({ nativeHistory: 'project-bound search, deduplication and restoration' })
      } finally {
        fault = undefined
        proxy.rule = () => null
        await writeFile(
          join(resultDir, 'cloud-history-search.json'),
          `${JSON.stringify(evidence, null, 2)}\n`
        )
        await writeFile(
          join(resultDir, 'cloud-history-search-requests.json'),
          `${JSON.stringify(
            proxy.requests.filter(entry => entry.stage),
            null,
            2
          )}\n`
        )
      }
    },
    async cleanup() {
      await proxy?.stop()
    },
  }
}
