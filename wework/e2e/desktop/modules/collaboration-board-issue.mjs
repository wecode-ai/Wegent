// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`

/** Prepare group ownership only; the caller retains every assignment and work-field choice. */
export async function prepareGroupThreadCreation(
  control,
  { groupName, groupId, contentSelector = CONTENT, timeoutMs }
) {
  const selector = '[data-testid="thread-create-group-select"]'
  await control.command('waitFor', selector, { visible: true, timeoutMs })
  const target = groupId ?? '__new__'
  if ((await control.command('getValue', selector)) !== target)
    await control.command('chooseWhenEnabled', selector, { value: target, timeoutMs })
  if (!groupId)
    await control.command('fill', '[data-testid="thread-create-new-group-name"]', {
      value: groupName,
    })
  await control.command('clickWhenEnabled', '[data-testid="thread-create-group-next"]', {
    timeoutMs,
  })
  const dialog = `${contentSelector} [data-testid="collaboration-issue-create-dialog"]`
  await control.command('waitFor', `${dialog} [data-testid="cloud-todo-create-panel"]`, {
    visible: true,
    timeoutMs,
  })
  return dialog
}

export async function createCollaborationBoardIssue(control, title, status, timeoutMs) {
  await control.command('clickWhenEnabled', scoped('[data-testid="collaboration-issue-create"]'))
  const dialog = await prepareGroupThreadCreation(control, {
    groupName: `${title} group`,
    timeoutMs,
  })
  await control.command('fill', `${dialog} [data-testid="cloud-todo-title"]`, {
    value: title,
  })
  await control.command('select', `${dialog} [data-testid="cloud-todo-create-status"]`, {
    value: status,
  })
  await control.command('clickWhenEnabled', `${dialog} [data-testid="cloud-todo-create-confirm"]`, {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="thread-room"]'), {
    text: title,
    visible: true,
    timeoutMs,
  })
  const detail = scoped('[data-testid="thread-room"]')
  await control.command('clickWhenEnabled', scoped('[data-testid="thread-back-to-board"]'))
  await control.command('waitFor', detail, {
    visible: false,
    timeoutMs,
  })
  const cardSelector = [
    `${CONTENT} button[data-testid^="cloud-todo-card-"]`,
    ':not([data-testid^="cloud-todo-card-task-"])',
    ':not([data-testid^="cloud-todo-card-more-"])',
    ':not([data-testid^="cloud-todo-card-archive-"])',
    ':not([data-testid^="cloud-todo-card-add-child-"])',
  ].join('')
  await control.command('markElementWithText', cardSelector, {
    text: title,
    value: `archive-issue-${status}-${title}`,
    timeoutMs,
  })
  const cardTestId = await control.command(
    'getAttribute',
    `[data-e2e-anchor-id="archive-issue-${status}-${title}"]`,
    { value: 'data-testid' }
  )
  assert.match(cardTestId ?? '', /^cloud-todo-card-.+$/)
  const issueId = cardTestId.slice('cloud-todo-card-'.length)
  await control.command('waitFor', scoped(`[data-testid="collaboration-issue-${issueId}"]`), {
    text: title,
    timeoutMs,
  })
  return issueId
}
