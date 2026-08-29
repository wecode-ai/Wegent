import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { waitForAttribute } from '../modules/workspace-flows.mjs'

const execFileAsync = promisify(execFile)
const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const CHANGE_REQUEST_BUTTON = '[data-testid="change-request-button"]'
const ENVIRONMENT_BUTTON = '[data-testid="environment-info-button"]'
const STATE_FILE = '.wework-change-request-e2e-state'
const TASK_PROMPT = 'Inspect the pull request status for this branch'
const TASK_COMPLETION = 'Pull request status fixture ready'

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(body)}\n`)
}

async function readJsonBody(request) {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  return body ? JSON.parse(body) : {}
}

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

async function createGitHubCliFixture(homePath) {
  const binPath = join(homePath, '.wework-e2e-bin')
  const fixturePath = join(binPath, 'gh.mjs')
  const executablePath = join(binPath, process.platform === 'win32' ? 'gh.cmd' : 'gh')
  await mkdir(binPath, { recursive: true })
  await writeFile(
    fixturePath,
    `import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
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
const args = process.argv.slice(2).join(' ')

if (args.includes('graphql')) {
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
} else {
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
}
`
  )
  if (process.platform === 'win32') {
    await writeFile(executablePath, '@echo off\r\nnode "%~dp0gh.mjs" %*\r\n')
  } else {
    await writeFile(executablePath, '#!/bin/sh\nexec node "$(dirname "$0")/gh.mjs" "$@"\n')
    await chmod(executablePath, 0o755)
  }
  process.env.PATH = `${binPath}${delimiter}${process.env.PATH ?? ''}`
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

function writeTaskCompletion(response) {
  const responseId = 'wework-change-request-e2e'
  const events = [
    {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.done',
      item: {
        id: 'wework-change-request-e2e-message',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: TASK_COMPLETION, annotations: [] }],
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

export async function createDesktopScenario({
  captureScreenshot,
  homePath,
  uiTimeoutMs,
  workspacePath,
}) {
  await configureGitFixture(workspacePath)
  await createGitHubCliFixture(homePath)
  const statePath = join(homePath, STATE_FILE)
  const gitSyncRequests = []
  await writeFile(statePath, 'pending\n')
  const capture = (control, name, selector = ACTIVE_WORKBENCH_SELECTOR) =>
    captureScreenshot(control, name, selector)

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/auth/wework/config') {
        json(response, 200, {
          web_url: `${url.protocol}//${url.host}`,
          socket_url: `${url.protocol}//${url.host}`,
        })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/users/me/git-accounts/sync-summary') {
        assert.equal(request.headers.authorization, 'Bearer wework-desktop-e2e-cloud-token')
        json(response, 200, {
          accounts: [
            {
              id: 'desktop-e2e-git-account',
              domain: 'git.example.test',
              provider: 'gitlab',
              login: 'desktop-e2e-user',
              email: 'desktop-e2e@example.test',
              effective: true,
              duplicate_of: null,
            },
          ],
          effective_count: 1,
          duplicate_count: 0,
        })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/devices') {
        assert.equal(request.headers.authorization, 'Bearer wework-desktop-e2e-cloud-token')
        json(response, 200, {
          items: [
            {
              id: 71,
              device_id: 'desktop-e2e-git-target',
              name: 'Git Sync Remote',
              status: 'online',
              is_default: false,
              device_type: 'remote',
              bind_shell: 'claudecode',
            },
            {
              id: 72,
              device_id: 'desktop-e2e-busy-cloud',
              name: 'Busy Cloud',
              status: 'busy',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
            },
            {
              id: 73,
              device_id: 'desktop-e2e-local',
              name: 'Local Device',
              status: 'online',
              is_default: false,
              device_type: 'local',
              bind_shell: 'claudecode',
            },
          ],
          total: 3,
        })
        return true
      }
      if (
        request.method === 'PUT' &&
        url.pathname === '/api/devices/desktop-e2e-git-target/git-accounts'
      ) {
        assert.equal(request.headers.authorization, 'Bearer wework-desktop-e2e-cloud-token')
        const body = await readJsonBody(request)
        gitSyncRequests.push(body)
        json(response, 200, {
          device_id: 'desktop-e2e-git-target',
          status: 'synced',
          synced_domains: ['git.example.test'],
          removed_domains: [],
          duplicate_domains: [],
          identity_warning_domains: [],
          cli: [
            {
              provider: 'glab',
              domain: 'git.example.test',
              status: 'configured',
              reason_code: null,
            },
          ],
          warning_codes: [],
        })
        return true
      }
      if (request.method === 'POST' && url.pathname === '/v1/responses') {
        for await (const _chunk of request) {
          // Consume the request before returning the deterministic response.
        }
        writeTaskCompletion(response)
        return true
      }
      return false
    },

    async verify(control) {
      await createLocalProject(control, workspacePath, uiTimeoutMs)
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
      await capture(control, 'change-request-status-04-checks-passed.png')

      await writeFile(statePath, 'unavailable\n')
      await refreshEnvironment(control)
      await control.command('waitFor', '[data-testid="change-request-lookup-hint"]', {
        text: '安装 GitHub CLI',
      })
      await control.command('waitFor', '[data-testid="create-pull-request-button"]')
      await capture(control, 'change-request-status-05-cli-unavailable.png')

      await control.command('click', '[data-testid="change-request-open-settings"]')
      await control.command('waitFor', '[data-testid="git-hosting-settings-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="git-hosting-cli-github-status"]', {
        text: '未登录',
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
      await control.command('click', '[data-testid="settings-nav-connections"]')
      await control.command('waitFor', '[data-testid="cloud-connection-status-card"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="git-device-sync-accounts"]', {
        text: 'gitlab · git.example.test',
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            '[data-testid="git-device-sync-select"] option[value="desktop-e2e-git-target"]'
          )
        ),
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
      await capture(control, 'change-request-status-06-settings-enabled.png', 'body')

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
      await capture(control, 'change-request-status-07-settings-disabled.png', 'body')

      await control.command('click', '[data-testid="change-request-status-switch"]')
      await waitForAttribute(
        control,
        '[data-testid="change-request-status-switch"]',
        'aria-checked',
        'true',
        'Re-enabling PR/MR status lookup was not persisted'
      )
      await control.command('click', '[data-testid="settings-back-button"]')
      await control.command('waitFor', ENVIRONMENT_BUTTON, { timeoutMs: uiTimeoutMs })
      await control.command('click', ENVIRONMENT_BUTTON)
      await control.command('waitFor', '[data-testid="environment-info-popover"]')

      await writeFile(statePath, 'merged\n')
      await refreshEnvironment(control)
      await control.command('waitFor', CHANGE_REQUEST_BUTTON, {
        text: '#2631',
      })
      await control.command('waitFor', '[data-testid="change-request-state"]', {
        text: '已合并',
      })
      await control.command('waitFor', '[data-testid="change-request-checks"]', {
        text: '检查通过',
      })
      await capture(control, 'change-request-status-08-recovered-merged.png')
    },

    diagnostics() {
      return { changeRequestState: statePath, gitSyncRequestCount: gitSyncRequests.length }
    },
  }
}
