import { inCollaborationSidebar } from './workspace-flows.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import assert from 'node:assert/strict'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const HOME_TASK_PROMPT = 'Personal home start work'
const HOME_TASK_RESULT = 'Personal home task complete'
const HOME_ISSUE_TITLE = '首页任务执行验证'

/** Only the model boundary is simulated; Issue, binding and execution remain real. */
export async function handlePersonalHomeModel(request, response, url) {
  if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
    return false
  const body = await readRequestBody(request)
  const text = JSON.stringify(body.input ?? [])
  if (!text.includes(HOME_TASK_PROMPT)) return false
  assert.ok(body.model, 'The Tasks composer must preserve the selected model')
  const generatingTitle = text.includes('适合作为任务标题')
  if (!generatingTitle)
    assert.match(text, /Issue/i, 'The task must reach the model with its real Issue context')
  const id = `personal-home-${Date.now()}`
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(
    createSse([
      responseCreated(id),
      assistantMessage(generatingTitle ? HOME_ISSUE_TITLE : HOME_TASK_RESULT),
      responseCompleted(id),
    ])
  )
  return true
}

/** Uses the shared-core scenario's real project, Issue and Executor fixtures. */
export async function verifyCollaborationPersonalHome(
  control,
  { scoped, project, issue, cloudAvailable = true }
) {
  await control.command(
    'click',
    inCollaborationSidebar('[data-testid="collaboration-primary-home"]')
  )
  await control.command('waitFor', scoped('[data-testid="personal-home"]'))
  await control.command('click', scoped('[data-testid="personal-home-scope-participating"]'))
  await control.command('waitFor', scoped(`[data-testid="personal-home-project-${project.id}"]`))
  await control.command('waitFor', scoped(`[data-testid="personal-home-issue-${issue.id}"]`), {
    text: issue.title,
  })
  await control.command('waitFor', scoped(`[data-testid="cloud-todo-card-assignee-${issue.id}"]`))
  await control.command('waitFor', scoped('[data-testid="personal-home-work-list"]'))
  for (const order of ['assignment', 'activity', 'priority', 'attention']) {
    await control.command('fill', scoped('[data-testid="personal-home-sort"]'), { value: order })
    await control.command(
      'waitFor',
      scoped('[data-testid="personal-home-items-region"][aria-busy="false"]')
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          scoped('[data-testid="personal-home-items-region"] [role="alert"]')
        )
      ),
      cloudAvailable ? 0 : 1,
      cloudAvailable
        ? `Both stores must load successfully with ${order} ordering`
        : `Unavailable cloud must remain visible without blocking local ${order} ordering`
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          scoped(`[data-testid="personal-home-issue-${issue.id}"]`)
        )
      ),
      1,
      'The local Issue remains available after every ordering request'
    )
  }
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        scoped('[data-testid="collaboration-issue-workspace"]')
      )
    ),
    1,
    'My work keeps its recording composer inline by default'
  )
  await control.command('click', scoped(`[data-testid="personal-home-issue-${issue.id}"]`))
  await control.command('waitFor', scoped('[data-testid="work-item-context-panel"]'))
  await control.command('waitFor', scoped('[data-testid="personal-home"]'))
  await control.command(
    'waitFor',
    scoped(`[data-testid="personal-home-tab-${issue.id}"][aria-selected="true"]`)
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        scoped('[data-testid="issue-persistent-task-action"]')
      )
    ),
    0,
    'The AI assistance bar must not appear before scrolling past linked tasks'
  )
  await control.command(
    'waitFor',
    scoped('[data-testid="cloud-todo-tasks"] [data-testid="cloud-todo-create-task"]')
  )
  await control.command(
    'click',
    scoped('[data-testid="cloud-todo-tasks"] [data-testid="cloud-todo-create-task"]')
  )
  await control.command(
    'waitFor',
    scoped('[data-testid="issue-conversation-drawers"][data-has-conversation="true"]')
  )
  await control.command('click', scoped('[data-testid="ai-chat-modal-close"]'))
  await control.command(
    'waitFor',
    scoped('[data-testid="issue-conversation-drawers"][data-has-conversation="false"]')
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid="personal-home-tab-${issue.id}"][aria-selected="true"]`)
  )
  await control.command('click', scoped('[data-testid="personal-home-tab-stand-in"]'))
  await control.command('waitFor', scoped('[data-testid="personal-home-work-list"]'))
  await control.command(
    'click',
    scoped(`[data-testid="personal-home-tab-${issue.id}-close-button"]`)
  )
}

/** Recording stays inline on the personal collaboration home. */
export async function openCollaborationIssueCreation(control, scoped) {
  await control.command(
    'click',
    inCollaborationSidebar('[data-testid="collaboration-primary-home"]')
  )
  await control.command('waitFor', scoped('[data-testid="personal-home"]'))
  const recordingMode = scoped('[data-testid="personal-home-record-mode"]')
  if (Number(await control.command('getElementCount', recordingMode)) > 0) {
    await control.command('click', recordingMode)
  } else {
    await control.command('waitFor', scoped('[data-testid="collaboration-first-project-starter"]'))
  }
}

/** Start work once using the full Tasks composer and an automatically linked Issue. */
export async function verifyPersonalHomeStartWork(control, { scoped, project, viewerId }) {
  assert.ok(viewerId != null, 'Start-work coverage needs the project viewer identity')
  const userId = Number(viewerId)
  const previous = await requestExecutor(
    control,
    'runtime.stand_in.personal.get',
    { userId },
    10_000
  )
  const template = previous.roles[0]
  assert.ok(template, 'Personal assistants expose an existing role template')
  await requestExecutor(
    control,
    'runtime.stand_in.personal.save',
    {
      userId,
      settings: {
        ...previous,
        roles: ['review', 'development'].map(id => ({
          ...template,
          id: `home-personal-${id}`,
          name: `Home ${id}`,
          enabled: true,
          handlingPolicy: {
            ...template.handlingPolicy,
            automatic: true,
            askBeforeAct: true,
            immediate: false,
          },
          collaboration: {
            enabled: true,
            allProjects: false,
            excludedProjects: [],
            tags: [],
            projects: [{ id: String(project.id), store: userId === 0 ? 'local' : 'cloud' }],
          },
        })),
      },
    },
    10_000
  )
  try {
    await verifyPersonalHomeStartWorkWithAssistants(control, { scoped, project, viewerId })
  } finally {
    const current = await requestExecutor(
      control,
      'runtime.stand_in.personal.get',
      { userId },
      10_000
    )
    await requestExecutor(
      control,
      'runtime.stand_in.personal.save',
      {
        userId,
        settings: { ...previous, version: current.version },
      },
      10_000
    )
  }
}

async function verifyPersonalHomeStartWorkWithAssistants(control, { scoped, project, viewerId }) {
  await openCollaborationIssueCreation(control, scoped)
  await control.command('click', scoped('[data-testid="collaboration-issue-project-trigger"]'))
  await control.command('click', `[data-testid="collaboration-issue-project-${project.id}"]`)
  await control.command('click', scoped('[data-testid="personal-home-new-issue"]'))
  const title = `${HOME_TASK_PROMPT} ${Date.now()}`
  await control.command('fill', scoped('[data-testid="personal-home-task-content"]'), {
    value: title,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="personal-home-start-task"]'))
  await control.command('waitFor', scoped('[data-testid="personal-home"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'))
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        scoped('[data-testid="personal-home-tabs"] [role="tab"]')
      )
    ),
    2,
    'The assistant stays fixed beside a single Issue detail'
  )
  await control.command(
    'waitFor',
    scoped('[data-testid="issue-conversation-drawers"][data-has-conversation="true"]')
  )
  await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), {
    text: HOME_TASK_RESULT,
  })
  await waitForValue(
    () => control.command('getValue', scoped('[data-testid="cloud-todo-detail-title"]')),
    value => value === HOME_ISSUE_TITLE,
    'The generated task title must be persisted back to its new Issue',
    10_000
  )
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        scoped('[data-testid="collaboration-issue-workspace"]')
      )
    ),
    1,
    'Starting work keeps the composer and Issue list on the home page'
  )
  await control.command('click', scoped('[data-testid="ai-chat-modal-close"]'))
  await control.command(
    'waitFor',
    scoped('[data-testid="issue-conversation-drawers"][data-has-conversation="false"]')
  )
  const linkedTask = scoped(
    '[data-testid="cloud-todo-task-list"] [data-testid^="cloud-todo-open-task-conversation-"]'
  )
  await control.command('waitFor', linkedTask)
  assert.equal(
    Number(await control.command('getElementCount', linkedTask)),
    1,
    'Starting work once must persist exactly one linked task'
  )
  const observationEnds = Date.now() + 11_000
  await waitForValue(
    async () => {
      assert.equal(
        (
          await control.command(
            'getText',
            scoped('[data-testid="cloud-todo-execution-task-count"]')
          )
        ).trim(),
        '1',
        'Automatic assistant intake must not reserve additional tasks for personal work'
      )
      return Date.now()
    },
    now => now >= observationEnds,
    'Observe a complete automatic intake interval',
    15_000
  )
  await control.command('click', linkedTask)
  await control.command(
    'waitFor',
    scoped('[data-testid="work-item-task-chat-panel"][aria-busy="false"]')
  )
  await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), {
    text: HOME_TASK_RESULT,
  })
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        scoped('[data-testid="ai-chat-modal"] [data-testid="runtime-transcript-error"]')
      )
    ),
    0,
    'Reopening the linked task must load its real conversation without a history error'
  )
  await control.command('click', scoped('[data-testid="ai-chat-modal-close"]'))
  const selectedTab = await control.command(
    'getAttribute',
    scoped('[data-testid^="personal-home-tab-"][aria-selected="true"]'),
    { value: 'data-testid' }
  )
  assert.ok(selectedTab.startsWith('personal-home-tab-'))
  const issueId = selectedTab.slice('personal-home-tab-'.length)
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-todo-card-header-${issueId}"]`),
    { text: HOME_ISSUE_TITLE }
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid^="personal-home-task-${issueId}-"][data-execution-state="succeeded"]`)
  )
  assert.equal(
    await control.command('getValue', scoped('[data-testid="cloud-todo-detail-assignee"]')),
    `user:${viewerId}`,
    'Starting my task must assign the Issue to the current user'
  )
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
}
