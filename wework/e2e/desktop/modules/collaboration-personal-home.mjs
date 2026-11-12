import { inCollaborationSidebar } from './workspace-flows.mjs'
import assert from 'node:assert/strict'

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
  const title = `Personal home start work ${Date.now()}`
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
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
}
