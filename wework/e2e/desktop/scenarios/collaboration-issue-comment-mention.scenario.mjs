import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createLocalCollaborationProject } from '../modules/workspace-flows.mjs'

const PROJECT_NAME = '评论提及成员回归'
const ISSUE_NAME = '评论 @ 成员必须弹出成员列表'
const ACTIVE_CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const ACTIVE_BOARD = `${ACTIVE_CONTENT} [data-testid="wework-collaboration-platform"]`
const MENTION_CANDIDATE_PREFIX = 'collaboration-issue-mention-member-'
const MENTION_MENU = '[data-testid="local-skill-autocomplete"]'
const MENTION_CHIP = '[data-composer-reference-kind="member"]'
const CARD_COMPOSER_PREFIX = 'cloud-task-activity-card-composer-'
const CARD_SEND_PREFIX = 'cloud-task-activity-card-send-'

function board(selector) {
  return `${ACTIVE_BOARD} ${selector}`
}

/**
 * The Issue detail page renders through the Wework collaboration platform, so
 * its comment composers only offer project members when that host wiring passes
 * the member list down. Both composers must offer the same picker the
 * collaboration home uses, keep the pick as its chip, and submit it as the
 * plain "@name" the home submits.
 */
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  async function mentionCandidate(control, scope) {
    const snapshot = JSON.parse(await control.command('snapshot', scope))
    const candidate = snapshot.testIds.find(testId => testId.startsWith(MENTION_CANDIDATE_PREFIX))
    assert.ok(
      candidate,
      `The comment composer did not offer any project member to mention: ${JSON.stringify(
        snapshot.testIds.filter(testId => testId.includes('mention'))
      )}`
    )
    return `[data-testid="${candidate}"]`
  }

  async function chooseMention(control, { captureName, composer, scope }) {
    const menu = board(MENTION_MENU)
    assert.equal(
      Number(await control.command('getElementCount', menu)),
      0,
      'The mention picker was already open before the draft contained an @ query'
    )
    await control.command('fill', composer, { value: '@' })
    await control.command('waitFor', menu, { visible: true, timeoutMs: uiTimeoutMs })
    const candidate = await mentionCandidate(control, scope)
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

      await control.command('click', board('[data-testid="collaboration-empty-project-create"]'))
      await control.command('waitFor', board('[data-testid="cloud-todo-title"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', board('[data-testid="cloud-todo-title"]'), {
        value: ISSUE_NAME,
      })
      await control.command(
        'clickWhenEnabled',
        board('[data-testid="cloud-todo-create-confirm"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      const boardSnapshot = await (async () => {
        const deadline = Date.now() + uiTimeoutMs
        while (Date.now() < deadline) {
          const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_BOARD))
          const item = snapshot.testIds.find(
            testId =>
              testId.startsWith('collaboration-issue-') &&
              !testId.startsWith('collaboration-issue-create') &&
              !testId.startsWith('collaboration-issue-detail')
          )
          if (item) return { item, snapshot }
          await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
        }
        assert.fail('The Issue detail fixture did not create an Issue card')
      })()
      await control.command('click', board(`[data-testid="${boardSnapshot.item}"]`), {
        visible: true,
      })
      await control.command('waitFor', board('[data-testid="cloud-todo-detail"]'), {
        timeoutMs: uiTimeoutMs,
      })

      const commentComposer = board('[data-testid="cloud-task-activity-composer"]')
      await control.command('waitFor', commentComposer, { visible: true, timeoutMs: uiTimeoutMs })
      const commentSend = board(
        '[data-testid="task-comment-form"] [data-testid="send-message-button"]'
      )
      const commentName = await chooseMention(control, {
        captureName: 'collaboration-issue-comment-mention-01-popup.png',
        composer: commentComposer,
        scope: ACTIVE_BOARD,
      })
      await control.command('clickWhenEnabled', commentSend, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', board('[data-testid="cloud-task-activity-list"]'), {
        text: `@${commentName}`,
        timeoutMs: uiTimeoutMs,
      })

      const cardSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_BOARD))
      const cardComposerTestId = cardSnapshot.testIds.find(testId =>
        testId.startsWith(CARD_COMPOSER_PREFIX)
      )
      assert.ok(
        cardComposerTestId,
        'The posted comment did not render a card reply composer in the Issue activity'
      )
      const rootId = cardComposerTestId.slice(CARD_COMPOSER_PREFIX.length)
      const replyName = await chooseMention(control, {
        captureName: 'collaboration-issue-comment-mention-02-card-reply.png',
        composer: board(`[data-testid="${cardComposerTestId}"]`),
        scope: ACTIVE_BOARD,
      })
      await control.command(
        'clickWhenEnabled',
        board(`[data-testid="${CARD_SEND_PREFIX}${rootId}"]`),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        board(`[data-testid="cloud-task-activity-replies-${rootId}"]`),
        {
          text: `@${replyName}`,
          timeoutMs: uiTimeoutMs,
        }
      )
    },
  }
}
