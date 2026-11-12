import { inCollaborationSidebar } from './workspace-flows.mjs'
import assert from 'node:assert/strict'
import { assistantMessage, createSse, readRequestBody, responseCompleted, responseCreated } from './response-protocol.mjs'

const HOME_TASK_PROMPT = 'Personal home start work'
const HOME_TASK_RESULT = 'Personal home task complete'

/** Only the model boundary is simulated; Issue, binding and execution remain real. */
export async function handlePersonalHomeModel(request, response, url) {
  if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) return false
  const body = await readRequestBody(request)
  const text = JSON.stringify(body.input ?? [])
  if (!text.includes(HOME_TASK_PROMPT)) return false
  assert.ok(body.model, 'The Tasks composer must preserve the selected model')
  assert.match(text, /Issue/i, 'The task must reach the model with its real Issue context')
  const id = `personal-home-${Date.now()}`
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(createSse([responseCreated(id), assistantMessage(HOME_TASK_RESULT), responseCompleted(id)]))
  return true
}

/** Uses the shared-core scenario's real project, Issue and Executor fixtures. */
export async function verifyCollaborationPersonalHome(control, { scoped, project, issue }) {
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
  await control.command('waitFor', scoped('[data-testid="personal-home-work-list"]'))
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
  assert.equal(Number(await control.command('getElementCount', scoped('[data-testid="issue-persistent-task-action"]'))), 0,
    'The AI assistance bar must not appear before scrolling past linked tasks')
  await control.command('waitFor', scoped('[data-testid="cloud-todo-tasks"] [data-testid="cloud-todo-create-task"]'))
  await control.command('click', scoped('[data-testid="cloud-todo-tasks"] [data-testid="cloud-todo-create-task"]'))
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
  await openCollaborationIssueCreation(control, scoped)
  await control.command('click', scoped('[data-testid="collaboration-issue-project-trigger"]'))
  await control.command('click', `[data-testid="collaboration-issue-project-${project.id}"]`)
  await control.command('click', scoped('[data-testid="personal-home-new-issue"]'))
  const title = `${HOME_TASK_PROMPT} ${Date.now()}`
  await control.command('fill', scoped('[data-testid="personal-home-task-content"]'), {
    value: title,
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="personal-home-start-task"]')
  )
  await control.command('waitFor', scoped('[data-testid="personal-home"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    text: title,
  })
  await control.command(
    'waitFor',
    scoped('[data-testid="issue-conversation-drawers"][data-has-conversation="true"]')
  )
  await control.command('waitFor', scoped('[data-testid="ai-chat-modal"]'), { text: HOME_TASK_RESULT })
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
  const linkedTask = scoped('[data-testid="cloud-todo-task-list"] [data-testid^="cloud-todo-open-task-conversation-"]')
  await control.command('waitFor', linkedTask)
  assert.equal(Number(await control.command('getElementCount', linkedTask)), 1,
    'Starting work once must persist exactly one linked task')
  assert.equal(await control.command('getValue', scoped('[data-testid="cloud-todo-detail-assignee"]')),
    `user:${viewerId}`, 'Starting my task must assign the Issue to the current user')
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
}
