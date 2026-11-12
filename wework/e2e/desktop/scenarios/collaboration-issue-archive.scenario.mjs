import assert from 'node:assert/strict'

import { createCollaborationBoardIssue as createIssue } from '../modules/collaboration-board-issue.mjs'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  captureVerificationScreenshot,
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
} from '../modules/workspace-flows.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = `协作任务归档-${process.pid}`
const FIRST_ISSUE = `单项归档恢复-${process.pid}`
const SECOND_ISSUE = `批量归档任务-${process.pid}`
const INCOMPLETE_ISSUE = `未完成不可归档-${process.pid}`

function scoped(selector) {
  return `${CONTENT} ${selector}`
}

async function revealIssueCard(control, issueId, title, timeoutMs) {
  const selector = scoped(`[data-testid="collaboration-issue-${issueId}"]`)
  // Restoring removes the archived row before the board snapshot finishes loading.
  await control.command('waitFor', selector, { text: title, timeoutMs })
  await control.command('scrollIntoView', selector)
  await control.command('waitFor', selector, {
    text: title,
    visible: true,
    timeoutMs,
  })
}

async function archiveIssue(control, issueId, title, timeoutMs) {
  await revealIssueCard(control, issueId, title, timeoutMs)
  await control.command('hover', scoped(`[data-testid="collaboration-issue-${issueId}"]`))
  await control.command('click', scoped(`[data-testid="cloud-todo-card-more-${issueId}"]`))
  await control.command('click', scoped(`[data-testid="cloud-todo-card-archive-${issueId}"]`))
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-archive-dialog"]'), {
    text: title,
    visible: true,
    timeoutMs,
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-issue-archive-confirm"]'),
    { timeoutMs }
  )
  await control.command('waitFor', scoped(`[data-testid="collaboration-issue-${issueId}"]`), {
    visible: false,
    timeoutMs,
  })
}

async function openArchiveDrawer(control, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-issue-archive-open"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-archive-drawer"]'), {
    visible: true,
    timeoutMs,
  })
}

async function waitForArchivedIssue(control, issueId, title, timeoutMs) {
  const archivedIssue = scoped(`[data-testid="collaboration-archived-issue-${issueId}"]`)
  await control.command('waitFor', archivedIssue, {
    text: title,
    visible: true,
    timeoutMs,
  })
  for (const selector of [
    scoped(`[data-testid="collaboration-archived-issue-restore-${issueId}"]`),
    scoped('[data-testid="collaboration-issue-archive-drawer-close"]'),
  ]) {
    await control.command('waitFor', selector, { visible: true, timeoutMs })
  }
}

async function assertArchiveControlsVisible(control, issueId) {
  const itemSelector = `[data-testid="collaboration-archived-issue-${issueId}"]`
  const drawer = scoped(`[data-testid="collaboration-issue-archive-drawer"]:has(${itemSelector})`)
  const panes = JSON.parse(
    await control.command(
      'getElementMetrics',
      scoped(`[data-testid="issue-drawer-workspace"]:has(${itemSelector})`)
    )
  )
  assert.equal(panes.length, 1, 'The archived item must identify one workbench content viewport')
  const [pane] = panes
  assert.ok(pane?.height > 0, 'The archive must have its real workbench content viewport')
  for (const selector of [
    `${drawer} header`,
    `${drawer} [data-testid="collaboration-issue-archive-drawer-close"]`,
  ]) {
    const boxes = JSON.parse(await control.command('getElementMetrics', selector))
    assert.equal(boxes.length, 1, `The archive header/control must be unique: ${selector}`)
    const [box] = boxes
    assert.ok(box?.height > 0, `The archive header/control must be rendered: ${selector}`)
    assert.equal(box.hitTestVisible, true, `The archive header/control is occluded: ${selector}`)
    assert.ok(
      box.visibleIntersection?.height >= box.height - 1 &&
        box.visibleIntersection?.width >= box.width - 1 &&
        box.top >= pane.top - 1 &&
        box.bottom <= pane.bottom + 1 &&
        box.left >= pane.left - 1 &&
        box.right <= pane.right + 1,
      `The archive header/control must fit its content viewport: ${JSON.stringify({ box, pane })}`
    )
  }
}

async function restoreIssue(control, issueId, title, timeoutMs) {
  await waitForArchivedIssue(control, issueId, title, timeoutMs)
  await control.command(
    'clickWhenEnabled',
    scoped(`[data-testid="collaboration-archived-issue-restore-${issueId}"]`),
    { timeoutMs }
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid="collaboration-archived-issue-${issueId}"]`),
    {
      visible: false,
      timeoutMs,
    }
  )
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await selectCollaborationProjectView(control, CONTENT, 'board')

      const firstIssueId = await createIssue(control, FIRST_ISSUE, 'completed', uiTimeoutMs)
      const secondIssueId = await createIssue(control, SECOND_ISSUE, 'completed', uiTimeoutMs)
      const incompleteIssueId = await createIssue(control, INCOMPLETE_ISSUE, 'inbox', uiTimeoutMs)

      await revealIssueCard(control, incompleteIssueId, INCOMPLETE_ISSUE, uiTimeoutMs)
      await control.command(
        'hover',
        scoped(`[data-testid="collaboration-issue-${incompleteIssueId}"]`)
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped(`[data-testid="cloud-todo-card-more-${incompleteIssueId}"]`)
          )
        ),
        0,
        'An incomplete Issue exposed an archive action'
      )

      await archiveIssue(control, firstIssueId, FIRST_ISSUE, uiTimeoutMs)
      await openArchiveDrawer(control, uiTimeoutMs)
      await waitForArchivedIssue(control, firstIssueId, FIRST_ISSUE, uiTimeoutMs)
      await assertArchiveControlsVisible(control, firstIssueId)
      await captureVerificationScreenshot(
        control,
        'collaboration-issue-archive-01-single-archived.png',
        CONTENT
      )
      await restoreIssue(control, firstIssueId, FIRST_ISSUE, uiTimeoutMs)
      await control.command(
        'click',
        scoped('[data-testid="collaboration-issue-archive-drawer-close"]')
      )
      await revealIssueCard(control, firstIssueId, FIRST_ISSUE, uiTimeoutMs)

      await control.command(
        'scrollIntoView',
        scoped('[data-testid="collaboration-issue-archive-completed"]')
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-issue-archive-completed"]')
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-issue-archive-dialog"]'),
        {
          text: '2 个已完成任务',
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="collaboration-issue-archive-confirm"]'),
        { timeoutMs: uiTimeoutMs }
      )
      for (const issueId of [firstIssueId, secondIssueId]) {
        await control.command('waitFor', scoped(`[data-testid="collaboration-issue-${issueId}"]`), {
          visible: false,
          timeoutMs: uiTimeoutMs,
        })
      }

      await openArchiveDrawer(control, uiTimeoutMs)
      for (const [issueId, title] of [
        [firstIssueId, FIRST_ISSUE],
        [secondIssueId, SECOND_ISSUE],
      ]) {
        await waitForArchivedIssue(control, issueId, title, uiTimeoutMs)
      }
      await assertArchiveControlsVisible(control, firstIssueId)
      await captureVerificationScreenshot(
        control,
        'collaboration-issue-archive-02-batch-archived.png',
        CONTENT
      )
      await restoreIssue(control, firstIssueId, FIRST_ISSUE, uiTimeoutMs)
      await restoreIssue(control, secondIssueId, SECOND_ISSUE, uiTimeoutMs)
      await control.command(
        'click',
        scoped('[data-testid="collaboration-issue-archive-drawer-close"]')
      )
      for (const [issueId, title] of [
        [firstIssueId, FIRST_ISSUE],
        [secondIssueId, SECOND_ISSUE],
      ]) {
        await revealIssueCard(control, issueId, title, uiTimeoutMs)
      }
    },
  }
}
