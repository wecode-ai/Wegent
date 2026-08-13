import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  const executablePath = join(binPath, 'gh')
  await mkdir(binPath, { recursive: true })
  await writeFile(
    executablePath,
    `#!/bin/sh
state="$(cat "$HOME/${STATE_FILE}" 2>/dev/null || printf pending)"
if [ "$state" = "unavailable" ]; then
  printf 'gh: command not found\\n' >&2
  exit 127
fi
if [ "$state" = "pending" ]; then
  checks='[{"status":"IN_PROGRESS","conclusion":""}]'
  pr_state='OPEN'
elif [ "$state" = "success" ]; then
  checks='[{"status":"COMPLETED","conclusion":"SUCCESS"}]'
  pr_state='OPEN'
else
  checks='[{"status":"COMPLETED","conclusion":"SUCCESS"}]'
  pr_state='MERGED'
fi
printf '[{"number":2631,"url":"https://github.com/wecode-ai/Wegent/pull/2631","title":"feat(wework): show pull request status","state":"%s","isDraft":false,"statusCheckRollup":%s}]\\n' "$pr_state" "$checks"
`
  )
  await chmod(executablePath, 0o755)
  process.env.PATH = `${binPath}:${process.env.PATH ?? ''}`
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
  await writeFile(statePath, 'pending\n')
  const capture = (control, name, selector = ACTIVE_WORKBENCH_SELECTOR) =>
    captureScreenshot(control, name, selector)

  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || url.pathname !== '/v1/responses') return false
      for await (const _chunk of request) {
        // Consume the request before returning the deterministic response.
      }
      writeTaskCompletion(response)
      return true
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
      await control.command('waitFor', '[data-testid="environment-info-popover"]')
      await capture(control, 'change-request-status-01-task-created.png')

      await control.command('waitFor', CHANGE_REQUEST_BUTTON, {
        text: '#2631',
      })
      await control.command('waitFor', '[data-testid="change-request-checks"]', {
        text: '检查中',
      })
      assert.match(
        await control.command('getText', CHANGE_REQUEST_BUTTON),
        /feat\(wework\): show pull request status/
      )
      await capture(control, 'change-request-status-02-pending.png')

      await writeFile(statePath, 'success\n')
      await refreshEnvironment(control)
      await control.command('waitFor', '[data-testid="change-request-checks"]', {
        text: '检查通过',
      })
      await capture(control, 'change-request-status-03-checks-passed.png')

      await writeFile(statePath, 'unavailable\n')
      await refreshEnvironment(control)
      await control.command('waitFor', '[data-testid="change-request-lookup-hint"]', {
        text: '安装 GitHub CLI',
      })
      await control.command('waitFor', '[data-testid="create-pull-request-button"]')
      await capture(control, 'change-request-status-04-cli-unavailable.png')

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
      await capture(control, 'change-request-status-05-settings-enabled.png', 'body')

      await control.command('click', '[data-testid="change-request-status-switch"]')
      await waitForAttribute(
        control,
        '[data-testid="change-request-status-switch"]',
        'aria-checked',
        'false',
        'Disabling PR/MR status lookup was not persisted'
      )
      await capture(control, 'change-request-status-06-settings-disabled.png', 'body')

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
      await capture(control, 'change-request-status-07-recovered-merged.png')
    },

    diagnostics() {
      return { changeRequestState: statePath }
    },
  }
}
