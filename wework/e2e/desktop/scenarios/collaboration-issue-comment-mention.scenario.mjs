import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
  reloadMainWindow,
} from '../modules/workspace-flows.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'

const PROJECT_NAME = '评论提及成员回归'
const ISSUE_NAME = '评论 @ 成员必须弹出成员列表'
const ACTIVE_CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const ACTIVE_BOARD = `${ACTIVE_CONTENT} [data-testid="wework-collaboration-platform"]`
const MENTION_CANDIDATE_PREFIX = 'collaboration-issue-mention-member-'
const MENTION_MENU = '[data-testid="local-skill-autocomplete"]'
const MENTION_CHIP = '[data-composer-reference-kind="member"]'
const REPLY_ACTION_PREFIX = 'group-message-reply-'
const scoped = id => `${ACTIVE_CONTENT} [data-testid="${id}"]`

function board(selector) {
  return `${ACTIVE_BOARD} ${selector}`
}

/**
 * Root messages and referenced replies use the same real editor and owning-group
 * roster. Both modes must keep selected mentions as chips, send plain @name,
 * and persist the reply relationship independently from the optional project.
 */
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  async function mentionCandidate(control) {
    const snapshot = JSON.parse(await control.command('snapshot', MENTION_MENU))
    const candidate = snapshot.testIds.find(testId => testId.startsWith(MENTION_CANDIDATE_PREFIX))
    assert.ok(
      candidate,
      `The comment composer did not offer any owning-group member to mention: ${JSON.stringify(
        snapshot.testIds.filter(testId => testId.includes('mention'))
      )}`
    )
    return `[data-testid="${candidate}"]`
  }

  async function chooseMention(control, { captureName, composer }) {
    const menu = MENTION_MENU
    assert.equal(
      Number(await control.command('getElementCount', menu)),
      0,
      'The mention picker was already open before the draft contained an @ query'
    )
    await control.command('fill', composer, { value: '@' })
    await control.command('waitFor', menu, { visible: true, timeoutMs: uiTimeoutMs })
    const candidate = await mentionCandidate(control)
    if (captureName) await captureScreenshot(control, captureName)
    await control.command('click', candidate, { visible: true })
    await control.command('waitFor', menu, {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    // The composer keeps the pick as the chip the home composer renders.
    const chip = `${composer} ${MENTION_CHIP}`
    await control.command('waitFor', chip, { timeoutMs: uiTimeoutMs })
    const memberName = (await control.command('getText', chip)).trim().replace(/^[@$]/, '')
    assert.ok(memberName.length > 0, 'The mention candidate did not expose a member name')
    return memberName
  }

  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command(
        'waitFor',
        `${ACTIVE_CONTENT} [data-testid="collaboration-platform-root"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await createLocalCollaborationProject(control, ACTIVE_CONTENT, PROJECT_NAME)
      await control.command('waitFor', board('[data-testid="cloud-project-header-title"]'), {
        text: PROJECT_NAME,
        timeoutMs: uiTimeoutMs,
      })
      await configureFirstProjectExecutionEnvironment(control, ACTIVE_CONTENT, uiTimeoutMs)
      await selectCollaborationProjectView(control, ACTIVE_BOARD, 'board')

      await control.command(
        'clickWhenEnabled',
        board('[data-testid="collaboration-empty-project-create"]')
      )
      await control.command('chooseWhenEnabled', '[data-testid="thread-create-group-select"]', {
        value: '__new__',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="thread-create-new-group-name"]', {
        value: `评论提及协作群-${process.pid}`,
      })
      await control.command('clickWhenEnabled', '[data-testid="thread-create-group-next"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('cloud-todo-title'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('cloud-todo-title'), {
        value: ISSUE_NAME,
      })
      await control.command('clickWhenEnabled', scoped('cloud-todo-create-confirm'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('thread-room'), {
        text: ISSUE_NAME,
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', `${scoped('group-message-input')}[contenteditable="true"]`, {
        timeoutMs: uiTimeoutMs,
      })

      const commentComposer = scoped('group-message-input')
      await control.command('waitFor', commentComposer, { visible: true, timeoutMs: uiTimeoutMs })
      const commentSend = scoped('group-message-send')
      const commentName = await chooseMention(control, {
        captureName: 'collaboration-issue-comment-mention-01-popup.png',
        composer: commentComposer,
      })
      await control.command('clickWhenEnabled', commentSend, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', scoped('group-message-list'), {
        text: `@${commentName}`,
        timeoutMs: uiTimeoutMs,
      })

      const collapsedCardSnapshot = JSON.parse(
        await control.command('snapshot', scoped('group-message-list'))
      )
      const replyAction = collapsedCardSnapshot.testIds.find(testId =>
        testId.startsWith(REPLY_ACTION_PREFIX)
      )
      assert.ok(replyAction, 'The posted comment did not expose a reply action in the Thread')
      const rootId = replyAction.slice(REPLY_ACTION_PREFIX.length)
      assert.equal(
        (await control.command('getText', scoped(`group-message-content-${rootId}`))).trim(),
        `@${commentName}`
      )
      await control.command('hover', scoped(`group-message-${rootId}`))
      await control.command('clickWhenEnabled', scoped(replyAction), { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', scoped('group-reply-context'), {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getAttribute', scoped('group-reply-context'), {
          value: 'data-reply-to-message-id',
        }),
        rootId
      )
      const replyName = await chooseMention(control, {
        captureName: 'collaboration-issue-comment-mention-02-card-reply.png',
        composer: commentComposer,
      })
      await control.command('clickWhenEnabled', commentSend, { timeoutMs: uiTimeoutMs })
      const replyRow = `${scoped('group-message-list')} [data-message-id][data-reply-to-message-id="${rootId}"]`
      await control.command('waitFor', replyRow, {
        text: `@${replyName}`,
        timeoutMs: uiTimeoutMs,
      })
      const replyId = await control.command('getAttribute', replyRow, { value: 'data-message-id' })
      assert.ok(replyId, 'The server-accepted reply did not retain its message identity')
      assert.equal(
        (await control.command('getText', scoped(`group-message-content-${replyId}`))).trim(),
        `@${replyName}`
      )
      await control.command('waitFor', scoped(`group-message-quoted-${replyId}`), {
        text: `@${commentName}`,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('group-reply-context'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'collaboration-issue-comment-mention-03-reply-sent.png')
      await reloadMainWindow(control, 'The root mention and its referenced reply must persist')
      await control.command('waitFor', replyRow, { text: `@${replyName}`, timeoutMs: uiTimeoutMs })
      assert.equal(
        (await control.command('getText', scoped(`group-message-content-${rootId}`))).trim(),
        `@${commentName}`
      )
      assert.equal(
        (await control.command('getText', scoped(`group-message-content-${replyId}`))).trim(),
        `@${replyName}`
      )
      await control.command('waitFor', scoped(`group-message-quoted-${replyId}`), {
        text: `@${commentName}`,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'collaboration-issue-comment-mention-04-reply-persisted.png')
    },
  }
}
