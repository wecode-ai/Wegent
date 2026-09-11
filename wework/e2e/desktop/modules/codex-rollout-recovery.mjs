import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { selectE2EModel } from './shared.mjs'

export const ROLLOUT_CHAT_PROMPT = 'WEWORK_E2E_CODEX_ROLLOUT_CHAT'

const CHILD_THREAD_ID = 'desktop-e2e-rollout-child'
const FIXTURE_PLUGIN_ID = 'codex-rollout-e2e'
const REPORT_PATH = '/codex-rollout-reports'
// Must match CODEX_ROLLOUT_SUBSCRIPTION in executor/src/hooks/model.rs.
const ROLLOUT_SUBSCRIPTION = 'codex_rollout'
const ROOT_FILES = ['desktop-e2e-a.ts', 'desktop-e2e-b.ts']
const CHILD_FILE = 'desktop-e2e-child.ts'
const OUR_FILES = [...ROOT_FILES, CHILD_FILE]
const CONTENT = 'const value = 1\n'
const ACTIVE_WORKSPACE_TAB_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const ACTIVE_WORKBENCH_SELECTOR =
  `${ACTIVE_WORKSPACE_TAB_SELECTOR} ` +
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const NEW_CHAT_SELECTOR = '[data-testid="runtime-chat-section-new-chat-button"]'
const POLL_INTERVAL_MS = 250
const TIMEOUT_FLOOR_MS = 30_000

/**
 * The hook command only has to prove which file change the executor handed it;
 * it reports what it received back to this scenario, which plays the reporting
 * service. It fails whenever the service is unavailable, so the executor has to
 * keep the change queued instead of dropping it.
 */
const FIXTURE_SCRIPT = `import { createHash } from 'node:crypto'

const endpoint = process.argv[2]
let hook = ''
for await (const chunk of process.stdin) hook += chunk
const input = JSON.parse(hook)
const changes = (input.tool_input?.changes ?? []).map(change => change.path)
const report = {
  id: createHash('sha256')
    .update([input.session_id, input.tool_use_id, ...changes].join('\\u0000'))
    .digest('hex'),
  sessionId: input.session_id,
  toolUseId: input.tool_use_id,
  agentId: input.agent_id ?? null,
  agentType: input.agent_type ?? null,
  toolName: input.tool_name,
  cwd: input.cwd,
  user: input.user ?? null,
  changes,
}
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(report),
})
if (!response.ok) {
  console.error(\`rollout report service responded \${response.status}\`)
  process.exit(1)
}
`

/**
 * Exercises the durable Codex rollout delivery of hook plugins end to end:
 *
 * - the executor registers the thread of a real chat turn whose workspace is
 *   not a Git repository,
 * - a fixture plugin that subscribes to the rollout feed is handed one file
 *   change per edited file instead of the live turn stream,
 * - a subagent rollout (a child thread pointing at the task thread) has its
 *   writes delivered as part of the same task,
 * - deliveries survive an unavailable service plus a desktop restart, and the
 *   same edit is never delivered twice.
 *
 * The fixture plugin is written into the executor's user hook directory, so the
 * scenario needs no build step and no product code of its own.
 *
 * `chatWorkspacePath` must be the directory the application uses for standalone
 * chats, so the chat this scenario starts shares the executor observing it.
 */
export function createCodexRolloutRecovery({ chatWorkspacePath, executorHome, uiTimeoutMs }) {
  const port = process.env.WEWORK_E2E_MODEL_SERVER_PORT
  assert.ok(port, 'Codex rollout recovery requires the desktop HTTP server')
  const endpoint = `http://127.0.0.1:${port}${REPORT_PATH}`
  const codexHome = join(executorHome, 'codex')
  const databasePath = join(executorHome, 'hooks', 'codex-rollout.sqlite')
  const accepted = new Map()
  const attempts = []
  let offline = false
  let restart

  writeFixturePlugin()

  function writeFixturePlugin() {
    const directory = join(executorHome, 'hooks', 'plugins', FIXTURE_PLUGIN_ID)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'report.mjs'), FIXTURE_SCRIPT)
    writeFileSync(
      join(directory, 'plugin.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: FIXTURE_PLUGIN_ID,
          name: 'Codex rollout E2E fixture',
          description: 'Reports the PostToolUse events the rollout observer delivers.',
          version: '1.0.0',
          subscriptions: [ROLLOUT_SUBSCRIPTION],
        },
        null,
        2
      )
    )
    // The interpreter is named by absolute path because the executor spawns
    // hook commands with a filtered environment.
    const command = [process.execPath, join(directory, 'report.mjs'), endpoint]
      .map(value => `"${value}"`)
      .join(' ')
    writeFileSync(
      join(directory, 'hooks.json'),
      JSON.stringify(
        {
          PostToolUse: [
            {
              matcher: '^apply_patch$',
              hooks: [
                {
                  type: 'command',
                  command,
                  timeout: 30,
                  async: false,
                  statusMessage: 'Reporting Codex rollout file changes',
                },
              ],
            },
          ],
        },
        null,
        2
      )
    )
  }

  function isOurs(entry) {
    return OUR_FILES.some(name => entry.changes.some(path => path.endsWith(name)))
  }

  function ours() {
    return [...accepted.values()].filter(isOurs)
  }

  function append(file, records) {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, records.map(JSON.stringify).join('\n') + '\n')
  }

  function edit(callId, files) {
    const changes = Object.fromEntries(
      files.map(name => [join(chatWorkspacePath, name), { type: 'add', content: CONTENT }])
    )
    return {
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'item_completed',
        item: { type: 'FileChange', id: callId, status: 'completed', changes },
      },
    }
  }

  function isChatWorkspace(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return false
    const inside = relative(chatWorkspacePath, cwd)
    return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
  }

  async function wait(predicate, description) {
    const deadline = Date.now() + Math.max(uiTimeoutMs, TIMEOUT_FLOOR_MS)
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    throw new Error(
      `Codex rollout recovery: ${description}; accepted=${accepted.size}, attempts=${attempts.length}`
    )
  }

  // The observer only adopts rollouts of threads the executor started, so the
  // scenario waits for the real chat turn to register before writing rollouts.
  function registeredChatThread() {
    if (!existsSync(databasePath)) return null
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      for (const row of database.prepare('SELECT id, context FROM threads').all()) {
        const cwd = JSON.parse(row.context).cwd
        if (typeof row.id === 'string' && isChatWorkspace(cwd)) return { cwd, threadId: row.id }
      }
    } finally {
      database.close()
    }
    return null
  }

  return {
    setRestartDesktopApp(value) {
      restart = value
    },
    async handleHttp(request, response, url) {
      if (url.pathname !== REPORT_PATH || request.method !== 'POST') return false
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      attempts.push(body)
      assert.equal(body.toolName, 'apply_patch', 'the recovered event is a file change')
      assert.ok(body.sessionId, 'every delivery names the task thread')
      if (isOurs(body)) assert.ok(body.cwd, 'every delivery names the workspace')
      if (!offline) accepted.set(body.id, body)
      response.writeHead(offline ? 503 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ success: !offline }))
      return true
    },
    async verify(control) {
      assert.equal(typeof restart, 'function', 'Desktop restart is required for rollout recovery')
      mkdirSync(chatWorkspacePath, { recursive: true })
      await control.command('click', NEW_CHAT_SELECTOR)
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await selectE2EModel(control)
      await control.command('fill', COMPOSER_SELECTOR, { value: ROLLOUT_CHAT_PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })

      const task = await wait(() => registeredChatThread(), 'the chat thread was never registered')
      assert.equal(
        existsSync(join(task.cwd, '.git')),
        false,
        'Rollout recovery must exercise a non-Git chat workspace'
      )

      // Deliveries observed before the restart must stay queued while the
      // service is unavailable, so the same edits are retried instead of lost.
      offline = true
      const rolloutDirectory = join(codexHome, 'sessions', 'desktop-e2e')
      const taskRollout = join(rolloutDirectory, `rollout-${task.threadId}.jsonl`)
      append(taskRollout, [
        { type: 'session_meta', payload: { id: task.threadId, cwd: task.cwd } },
        edit('desktop-e2e-root-edit', ROOT_FILES),
      ])
      append(join(rolloutDirectory, `rollout-${CHILD_THREAD_ID}.jsonl`), [
        {
          type: 'session_meta',
          payload: {
            id: CHILD_THREAD_ID,
            parent_thread_id: task.threadId,
            thread_source: 'subagent',
            source: { subagent: { thread_spawn: { parent_thread_id: task.threadId } } },
          },
        },
        edit('desktop-e2e-child-edit', [CHILD_FILE]),
      ])
      await wait(
        () => new Set(attempts.filter(isOurs).map(attempt => attempt.id)).size === OUR_FILES.length,
        'the task edit and the subagent edit must both be observed while offline'
      )

      await restart(async () => {
        offline = false
      })
      await wait(
        () => ours().length === OUR_FILES.length,
        'every queued edit must drain after the restart'
      )

      const reported = ours()
      assert.ok(
        reported.every(entry => entry.sessionId === task.threadId),
        'subagent writes must be delivered as part of the task session'
      )
      const paths = reported.flatMap(entry => entry.changes)
      for (const name of OUR_FILES) {
        assert.ok(
          paths.some(path => path.endsWith(name)),
          `missing rollout delivery for ${name}`
        )
      }
      assert.equal(
        new Set(paths).size,
        OUR_FILES.length,
        'every written file must be delivered exactly once'
      )
      const subagent = reported.find(entry => entry.changes.some(path => path.endsWith(CHILD_FILE)))
      assert.equal(subagent?.agentId, CHILD_THREAD_ID, 'the subagent thread must be identified')
      assert.equal(subagent?.agentType, 'subagent')
      // Retries of a queued edit must reuse its delivery id.
      assert.equal(
        new Set(attempts.filter(isOurs).map(attempt => attempt.id)).size,
        OUR_FILES.length,
        'retried edits must keep a single delivery id'
      )

      // The observer keeps tailing after the restart.
      append(taskRollout, [edit('desktop-e2e-after-restart', [ROOT_FILES[0]])])
      await wait(
        () => ours().length === OUR_FILES.length + 1,
        'edits written after the restart must be delivered'
      )
    },
    diagnostics() {
      return { accepted: accepted.size, attempts: attempts.length, offline }
    },
  }
}
