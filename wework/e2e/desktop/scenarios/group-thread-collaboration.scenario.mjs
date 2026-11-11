import assert from 'node:assert/strict'
import { URL } from 'node:url'

import { createLocalCollaborationProject, reloadMainWindow } from '../modules/workspace-flows.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createBoardReturnVerification } from '../modules/group-thread-board-return.mjs'
import { waitForSnapshot } from '../modules/conversation-layout.mjs'
import { ensureTaskRowVisible } from '../modules/memory-tool-flows.mjs'
import { readFile } from 'node:fs/promises'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = testId => `${CONTENT} [data-testid="${testId}"]`
const GROUP_NAME = `独立群协作验收-${process.pid}`
const THREAD_TITLE = `统一交付入口-${process.pid}`
const DISCUSSION = `只属于事项的讨论-${process.pid}`
const PRIVATE_RESULT = 'GROUP_THREAD_PRIVATE_RUNTIME_COMPLETE'

/** Establish all prerequisites through the real local UI, including standalone runs. */
export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
  workspacePath,
}) {
  const wait = (control, testId, extra = {}) =>
    control.command('waitFor', scoped(testId), { timeoutMs: uiTimeoutMs, ...extra })
  const click = (control, testId) => control.command('click', scoped(testId))
  const fill = (control, testId, value) => control.command('fill', scoped(testId), { value })
  const capture = async (control, name) => {
    assert.equal(
      Number(
        await control.command('getElementCount', `${CONTENT} [role="alert"]`, { visible: true })
      ),
      0,
      `The local collaboration flow displayed an error before ${name}`
    )
    return captureScreenshot(control, name, CONTENT)
  }

  const {
    selectFilters: selectReturnBoardFilters,
    assertFilters: assertReturnBoardFilters,
    readSelectedView,
  } = createBoardReturnVerification(CONTENT, uiTimeoutMs)

  async function createPrivateSession(control, prompt, createWorkspace = false) {
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    if (createWorkspace) {
      await createSingleRootLocalProject(
        control,
        workspacePath,
        'Private Thread execution workspace'
      )
    } else {
      await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]')
    }
    await selectE2EModel(control, 'local-model:desktop-e2e-responses', 'Desktop E2E Responses')
    const pane = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
    await control.command(
      'fill',
      `${pane} [data-testid="chat-message-input"][contenteditable="true"]`,
      { value: prompt }
    )
    await control.command('clickWhenEnabled', `${pane} [data-testid="send-message-button"]`)
    await control.command('waitFor', `${pane} [data-testid="desktop-chat-scroll"]`, {
      text: PRIVATE_RESULT,
      timeoutMs: modelResponseTimeoutMs,
    })
    await control.command('waitFor', `${pane} [data-testid="pause-response-button"]`, {
      visible: false,
    })
    const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot'))
    const address = debug.workbench.currentRuntimeTask
    assert.ok(address?.taskId && address.deviceId)
    return address
  }

  async function verifyLegacyMigration(control, groupId, previousTaskId) {
    const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
    await createLocalCollaborationProject(control, CONTENT, `历史迁移项目-${process.pid}`)
    const projectTestId = await control.command(
      'getAttribute',
      `${CONTENT} [data-testid^="collaboration-workspace-project-"][aria-current="page"]`,
      { value: 'data-testid' }
    )
    assert.ok(projectTestId?.startsWith('collaboration-workspace-project-'))
    const projectId = projectTestId.slice('collaboration-workspace-project-'.length)
    // Seed legacy containment through the actual Native API; new UI creation stays group-owned.
    const title = `迁移后继续协作-${process.pid}`
    const thread = await rpc('todos.create', {
      project_id: projectId,
      todo: { title, status: 'pending', tags: ['迁移保留标签'] },
    })
    const completed = await rpc('todos.create', {
      project_id: projectId,
      todo: { title: '已完成的历史事项', status: 'completed' },
    })
    const comment = await rpc('todos.comment.create', {
      comment: {
        project_id: projectId,
        task_id: thread.id,
        sender_type: 'user',
        sender_id: '0',
        sender_name: '你',
        content: '迁移前的讨论完整保留',
        metadata: {},
      },
    })
    const attachment = await rpc('attachments.add', {
      project_id: projectId,
      item_id: thread.id,
      file: {
        display_name: 'legacy-review.txt',
        content_type: 'text/plain',
        base64: Buffer.from('历史附件原文').toString('base64'),
      },
    })
    const beforeFile = await rpc('attachments.access', {
      project_id: projectId,
      item_id: thread.id,
      attachment_id: attachment.id,
    })
    const delivery = await rpc('deliveries.create', {
      project_id: projectId,
      item_id: thread.id,
      delivery: { title: '历史交付', markdown: '迁移前的交付快照' },
    })
    await rpc('deliveries.finalize', { item_id: thread.id, delivery_id: delivery.id })
    const address = await createPrivateSession(control, 'GROUP_THREAD_MIGRATION_PRIVATE_RUNTIME')
    assert.notEqual(address.taskId, previousTaskId)
    const binding = await rpc('todos.bind', {
      project_id: projectId,
      item_id: thread.id,
      task: { deviceId: address.deviceId, taskId: address.taskId },
    })
    const { inventory } = await rpc('chat_groups.migration.inspect', {
      source_project_id: projectId,
      target_group_id: groupId,
    })
    assert.equal(inventory.entries.length, 2)
    const migrated = await rpc('chat_groups.migration.apply', {
      inventory,
      retain_source_project: true,
    })
    assert.equal(migrated.replayed, false)
    const replay = await rpc('chat_groups.migration.apply', {
      inventory,
      retain_source_project: true,
    })
    assert.equal(replay.replayed, true)
    assert.equal(replay.checkpoint_id, migrated.checkpoint_id)
    const after = await rpc('todos.get', { project_id: groupId, task_id: thread.id })
    assert.equal(after.cloud_project_id, groupId)
    assert.equal(after.group_id, groupId)
    assert.equal(after.joined, true)
    assert.deepEqual(after.metadata.tags, ['迁移保留标签'])
    const bindings = await rpc('todos.bindings', { task_id: thread.id })
    assert.ok(
      bindings.some(
        item =>
          item.id === binding.id &&
          item.task_id === address.taskId &&
          item.cloud_project_id === groupId &&
          item.task_user_id === 0
      )
    )
    const afterFile = await rpc('attachments.access', {
      project_id: groupId,
      item_id: thread.id,
      attachment_id: attachment.id,
    })
    assert.equal(afterFile.path, beforeFile.path)
    assert.equal(await readFile(afterFile.path, 'utf8'), '历史附件原文')
    assert.equal(
      (await rpc('deliveries.get', { delivery_id: delivery.id })).markdown,
      '迁移前的交付快照'
    )
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await control.command('openWeworkScheme', 'body', {
      value: `wework://groups/local/${encodeURIComponent(groupId)}/threads/${encodeURIComponent(thread.id)}`,
    })
    await wait(control, 'thread-room', { text: title })
    await wait(control, 'group-message-list', { text: comment.content })
    await wait(control, `thread-nav-${thread.id}`)
    await wait(control, `thread-nav-${completed.id}`, { visible: false })
    assert.equal(
      (await control.command('getText', scoped('group-message-list'))).includes(PRIVATE_RESULT),
      false
    )
    await capture(control, 'group-thread-native-migration-restored.png')
    await reloadMainWindow(control)
    await wait(control, 'thread-room', { text: title })
    await wait(control, 'group-message-list', { text: comment.content })
    await click(control, 'thread-settings')
    await wait(control, 'thread-project-select')
    assert.equal(await control.command('getValue', scoped('thread-project-select')), projectId)
    await capture(control, 'group-thread-native-migration-project-link.png')
    await click(control, 'thread-settings-close')
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    const originalRow = `runtime-local-task-row-${address.taskId}`
    await ensureTaskRowVisible(control, originalRow)
    await control.command('clickWhenEnabled', `[data-testid="${originalRow}"]`, { visible: true })
    const pane = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
    await control.command('waitFor', `${pane} [data-testid="desktop-chat-scroll"]`, {
      text: 'GROUP_THREAD_MIGRATION_PRIVATE_RUNTIME',
    })
    const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot'))
    assert.equal(debug.workbench.currentRuntimeTask.taskId, address.taskId)
    const beforeText = await control.command(
      'getText',
      `${pane} [data-testid="desktop-chat-scroll"]`
    )
    const beforeCount = beforeText.split(PRIVATE_RESULT).length - 1
    await control.command(
      'fill',
      `${pane} [data-testid="chat-message-input"][contenteditable="true"]`,
      { value: '迁移后继续原来的私人会话' }
    )
    await control.command('clickWhenEnabled', `${pane} [data-testid="send-message-button"]`)
    await waitForSnapshot(
      control,
      snapshot => snapshot.text.split(PRIVATE_RESULT).length - 1 > beforeCount,
      'The original private session did not continue after migration',
      modelResponseTimeoutMs,
      `${pane} [data-testid="desktop-chat-scroll"]`
    )
    await control.command('waitFor', `${pane} [data-testid="pause-response-button"]`, {
      visible: false,
    })
    const continued = JSON.parse(await control.command('getWorkbenchDebugSnapshot'))
    assert.equal(continued.workbench.currentRuntimeTask.taskId, address.taskId)
    await captureScreenshot(control, 'group-thread-native-migration-private-session.png', pane)
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await wait(control, 'thread-room', { text: title })
    assert.equal(
      (await control.command('getText', scoped('group-message-list'))).includes(PRIVATE_RESULT),
      false
    )
    await capture(control, 'group-thread-native-migration-private-result-isolated.png')
  }

  return {
    appEnvironment: {
      WEWORK_E2E_CLOUD_BACKEND_URL: '',
      VITE_WEWORK_E2E_CLOUD_BACKEND_URL: '',
      WEWORK_E2E_CLOUD_TOKEN: '',
      VITE_WEWORK_E2E_CLOUD_TOKEN: '',
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const events = streamingTextEvents(
        `group-private-runtime-${Date.now()}`,
        PRIVATE_RESULT,
        'final_answer'
      )
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          ...events.start,
          {
            type: 'response.output_text.delta',
            item_id: events.itemId,
            output_index: 0,
            content_index: 0,
            delta: PRIVATE_RESULT,
            offset: 0,
          },
          ...events.finish,
        ])
      )
      return true
    },
    async verify(control) {
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await wait(control, 'collaboration-view-groups')
      await click(control, 'collaboration-view-groups')
      await wait(control, 'collaboration-groups')
      await wait(control, 'group-empty-create')
      await capture(control, 'group-thread-first-use.png')
      await click(control, 'group-create-open')
      await control.command('fill', '[data-testid="create-group-name"]', { value: GROUP_NAME })
      await control.command('select', '[data-testid="create-group-store"]', { value: 'local' })
      await captureScreenshot(control, 'group-thread-group-create-form.png', 'body')
      await control.command('click', '[data-testid="create-group-submit"]')
      await wait(control, 'group-room')
      await control.command('waitFor', `${CONTENT} .composer-prosemirror-placeholder`, {
        text: '发送消息，输入 @ 提及成员',
        timeoutMs: uiTimeoutMs,
      })

      await fill(control, 'group-message-input', '主群自己的交流')
      await click(control, 'group-message-send')
      await wait(control, 'group-message-list', { text: '主群自己的交流' })
      await click(control, 'group-start-thread')
      await control.command('fill', '[data-testid="create-thread-name"]', { value: THREAD_TITLE })
      await control.command('click', '[data-testid="create-thread-submit"]')
      await wait(control, 'thread-room', { text: THREAD_TITLE })
      const initial = JSON.parse(await control.command('snapshot', CONTENT))
      const location = new URL(initial.location)
      const threadId = location.searchParams.get('threadId')
      const groupId = location.searchParams.get('groupId')
      assert.ok(threadId && groupId, 'The new Thread did not expose its owning group route')
      const sidebarThread = `thread-nav-${threadId}`
      await wait(control, sidebarThread)
      await control.command('waitFor', `${scoped('group-message-input')}[contenteditable="true"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await fill(control, 'group-message-input', DISCUSSION)
      await click(control, 'group-message-send')
      await wait(control, 'group-message-list', { text: DISCUSSION })
      const messageId = await control.command(
        'getAttribute',
        `${scoped('group-message-list')} article[data-message-id]`,
        { value: 'data-message-id' }
      )
      assert.ok(messageId && messageId !== 'null', 'The discussion has no stable message identity')
      await control.command('fill', scoped('group-message-input'), { value: '@' })
      await control.command('waitFor', `${CONTENT} [data-testid="local-skill-autocomplete"]`, {
        timeoutMs: uiTimeoutMs,
      })
      const mentionSnapshot = JSON.parse(await control.command('snapshot', CONTENT))
      const mentionId = mentionSnapshot.testIds.find(id =>
        id.startsWith('collaboration-issue-mention-member-')
      )
      assert.ok(mentionId, 'Group members must be available in the mention picker')
      await click(control, mentionId)
      await control.command(
        'waitFor',
        `${scoped('group-message-input')} [data-composer-reference-kind="member"]`,
        {
          timeoutMs: uiTimeoutMs,
          text: '你',
        }
      )
      await control.command('selectFile', scoped('group-message-file'), {
        filename: 'thread-review.txt',
        mimeType: 'text/plain',
        value: Buffer.from('事项附件验收内容').toString('base64'),
      })
      await control.command('waitFor', scoped(`cloud-task-activity-card-attachments-${threadId}`), {
        text: 'thread-review.txt',
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'group-thread-mention-attachment.png')
      await control.command('clickWhenEnabled', scoped('group-message-send'), {
        timeoutMs: uiTimeoutMs,
      })
      await wait(control, 'group-message-list', { text: 'thread-review.txt' })
      const discussionUrl = `wework://groups/local/${encodeURIComponent(groupId)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(messageId)}`
      const longDiscussion = Array.from(
        { length: 45 },
        (_, index) => `历史定位上下文 ${index + 1}`
      ).join('\n\n')
      await fill(control, 'group-message-input', longDiscussion)
      await click(control, 'group-message-send')
      await wait(control, 'group-message-list', { text: '历史定位上下文 45' })

      await click(control, 'thread-settings')
      await fill(control, 'thread-settings-title', '尚未保存的草稿')
      await click(control, 'collaboration-view-projects')
      await control.command('waitFor', '[data-testid="thread-settings-discard"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getActiveElementTestId', 'body'),
        'thread-settings-discard-cancel-button',
        'Discarding a draft must not be the default keyboard action'
      )
      await control.command('click', '[data-testid="thread-settings-discard-cancel-button"]')
      assert.equal(
        await control.command('getValue', scoped('thread-settings-title')),
        '尚未保存的草稿'
      )
      await fill(control, 'thread-settings-title', THREAD_TITLE)
      await fill(control, 'thread-settings-description', '验收群与事项的独立生命周期')
      const today = new Intl.DateTimeFormat('sv-SE').format(new Date())
      await fill(control, 'thread-settings-start', `${today}T09:00`)
      await fill(control, 'thread-settings-due', `${today}T17:00`)
      await fill(control, 'thread-settings-tags-input', '自定义/待评审')
      await control.command('press', scoped('thread-settings-tags-input'), { key: 'Enter' })
      await wait(control, 'thread-settings-tags-tag-自定义/待评审')
      await click(control, 'thread-settings-save')
      await wait(control, 'thread-settings-panel', { text: '已保存' })
      for (const [value, label] of [
        ['pending', '待开始'],
        ['in_progress', '进行中'],
        ['in_review', '待确认'],
      ]) {
        await control.command('select', scoped('thread-settings-status'), { value })
        await click(control, 'thread-settings-save')
        await wait(control, 'thread-settings-panel', { text: '已保存' })
        await click(control, 'thread-settings-close')
        await control.command('waitFor', `${scoped('thread-room')} header`, {
          text: label,
          timeoutMs: uiTimeoutMs,
        })
        await capture(control, `group-thread-status-${value}.png`)
        await click(control, 'thread-settings')
      }
      await control.command('select', scoped('thread-notification-preference'), { value: 'muted' })
      await click(control, 'thread-settings-close')

      await reloadMainWindow(control)
      await wait(control, 'thread-room', { text: THREAD_TITLE })
      await click(control, 'thread-settings')
      assert.equal(await control.command('getValue', scoped('thread-settings-status')), 'in_review')
      await wait(control, 'thread-settings-tags-tag-自定义/待评审')
      assert.equal(
        await control.command('getValue', scoped('thread-settings-description')),
        '验收群与事项的独立生命周期'
      )
      assert.equal(
        await control.command('getValue', scoped('thread-notification-preference')),
        'muted',
        'The local principal lost its persisted notification preference'
      )
      await capture(control, 'group-thread-settings.png')
      await click(control, 'thread-settings-close')
      await click(control, 'thread-back-to-group')
      await click(control, 'group-tab-threads')
      await wait(control, `thread-list-${threadId}`, { text: '待确认' })
      await capture(control, 'group-thread-list-localized-status.png')
      await click(control, `thread-list-${threadId}`)
      await click(control, 'thread-more')
      await control.command('waitFor', '[data-testid="thread-menu-lifecycle"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'group-thread-more-complete-action.png', 'body')
      await control.command('click', '[data-testid="thread-menu-lifecycle"]')
      await wait(control, 'thread-room', { text: '已完成' })
      await wait(control, sidebarThread, { visible: false })
      await fill(control, 'group-message-input', '完成后仍可补充讨论')
      await click(control, 'group-message-send')
      await wait(control, 'group-message-list', { text: '完成后仍可补充讨论' })
      await click(control, 'thread-back-to-group')
      await wait(control, 'group-message-list', { text: '完成了事项' })
      const rootText = await control.command('getText', scoped('group-message-list'))
      assert.ok(rootText.includes('主群自己的交流'))
      assert.ok(
        !rootText.includes(DISCUSSION),
        'A child discussion leaked into the parent timeline'
      )
      await capture(control, 'group-thread-lifecycle.png')
      assert.ok(
        !rootText.includes('完成后仍可补充讨论'),
        'A completed child discussion leaked into the parent timeline'
      )

      await control.command('click', `${CONTENT} [data-testid^="group-thread-event-"]`)
      await wait(control, 'thread-room', { text: THREAD_TITLE })
      await click(control, 'thread-more')
      await control.command('click', '[data-testid="thread-menu-leave"]')
      await wait(control, 'thread-observer')
      await wait(control, sidebarThread, { visible: false })
      await click(control, 'thread-back-to-group')
      await click(control, 'group-tab-threads')
      await click(control, 'thread-filter-all')
      await wait(control, `thread-list-${threadId}`, { text: '已完成' })
      await wait(control, sidebarThread, { visible: false })
      await capture(control, 'group-thread-unjoined-list-discovery.png')
      await click(control, `thread-list-${threadId}`)
      await wait(control, 'thread-observer')
      await control.command('openWeworkScheme', 'body', { value: discussionUrl })
      await wait(control, 'thread-observer')
      await control.command(
        'waitFor',
        `${scoped(`group-message-${messageId}`)}[data-focused="true"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await capture(control, 'group-thread-message-link-observer.png')
      const firstFocus = new URL(
        JSON.parse(await control.command('snapshot', CONTENT)).location
      ).searchParams.get('focusRequest')
      await control.command('openWeworkScheme', 'body', { value: discussionUrl })
      await control.command(
        'waitFor',
        `${scoped('thread-room')}[data-focus-request]:not([data-focus-request="${firstFocus}"])`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        `${scoped(`group-message-${messageId}`)}[data-focused="true"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      const secondFocus = new URL(
        JSON.parse(await control.command('snapshot', CONTENT)).location
      ).searchParams.get('focusRequest')
      assert.ok(
        firstFocus && secondFocus && firstFocus !== secondFocus,
        'A repeated link did not create a new focus request'
      )
      await wait(control, 'group-history-window')
      await click(control, 'group-history-newer')
      await wait(control, 'group-message-list', { text: '历史定位上下文 45' })
      await click(control, 'group-history-latest')
      await wait(control, 'group-history-window', { visible: false })
      await wait(control, 'group-message-list', { text: DISCUSSION })
      await wait(control, 'group-message-list', { text: '完成后仍可补充讨论' })
      await wait(control, 'thread-observer')
      await wait(control, sidebarThread, { visible: false })
      await click(control, 'thread-join')
      await wait(control, 'group-message-input')
      await wait(control, sidebarThread, { visible: false })
      await click(control, 'thread-more')
      await control.command('waitFor', '[data-testid="thread-menu-notifications"]', {
        text: '接收通知',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="thread-menu-lifecycle"]')
      await wait(control, sidebarThread)
      await click(control, 'thread-back-to-group')
      await click(control, 'group-tab-board')
      for (const id of [
        'collaboration-board',
        'collaboration-calendar-tab',
        'collaboration-gantt-tab',
        'collaboration-tab-table',
      ]) {
        await wait(control, id)
      }
      assert.equal(
        Number(await control.command('getElementCount', scoped('collaboration-tab-manage'))),
        0
      )
      assert.equal(
        Number(await control.command('getElementCount', scoped('group-start-thread'))),
        0
      )
      const builtInView = await control.command('getText', scoped('board-view-picker'))
      const viewName = '群评审视图'
      await click(control, 'board-view-picker')
      await control.command('click', '[data-testid="board-view-new"]')
      await control.command('fill', '[data-testid="board-view-name"]', { value: viewName })
      await control.command('click', '[data-testid="board-view-set-default"]')
      await captureScreenshot(control, 'group-thread-saved-view-create.png', 'body')
      await control.command('click', '[data-testid="board-view-save"]')
      await control.command('waitFor', '[data-testid="board-view-editor"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await wait(control, 'board-view-picker', { text: viewName })
      await click(control, 'board-view-picker')
      await control.command(
        'markElementWithText',
        '[data-testid="board-view-menu"] [role="menuitemradio"]',
        {
          text: viewName,
          value: 'group-saved-view',
          timeoutMs: uiTimeoutMs,
        }
      )
      const savedViewId = await control.command(
        'getAttribute',
        '[data-e2e-anchor-id="group-saved-view"]',
        {
          value: 'data-testid',
        }
      )
      assert.ok(savedViewId?.startsWith('board-view-'))
      await control.command('click', '[data-testid="board-view-default"]')
      await wait(control, 'board-view-picker', { text: builtInView })
      await click(control, 'board-view-picker')
      await control.command('click', `[data-testid="${savedViewId}"]`)
      await wait(control, 'board-view-picker', { text: viewName })
      await capture(control, 'group-thread-saved-view-selected.png')
      await reloadMainWindow(control)
      await wait(control, 'board-view-picker', { text: viewName })
      await capture(control, 'group-thread-saved-view-restored.png')
      await click(control, 'collaboration-calendar-tab')
      await wait(control, 'collaboration-calendar', { text: THREAD_TITLE })
      const calendarText = await control.command('getText', scoped('collaboration-calendar'))
      assert.ok(calendarText.includes('17:00'), 'The calendar lost the persisted deadline time')
      assert.ok(
        !calendarText.includes('项目设置'),
        'The group calendar exposed project-specific settings copy'
      )
      await capture(control, 'group-thread-calendar.png')
      await click(control, 'collaboration-gantt-tab')
      await wait(control, `collaboration-gantt-row-${threadId}`, { text: THREAD_TITLE })
      await capture(control, 'group-thread-gantt.png')
      await click(control, 'collaboration-tab-table')
      await wait(control, `collaboration-issue-table-row-${threadId}`, { text: THREAD_TITLE })
      await capture(control, 'group-thread-table.png')
      await click(control, 'collaboration-tab-board')
      await wait(control, 'collaboration-board')
      await capture(control, 'group-thread-board.png')
      await click(control, 'board-view-picker')
      await control.command('waitFor', `[data-testid="${savedViewId}"]`, { text: '默认' })
      await control.command('click', '[data-testid="board-view-default"]')
      await wait(control, 'board-view-picker', { text: builtInView })
      assert.notEqual(savedViewId, 'board-view-default')
      const groupFilters = await selectReturnBoardFilters(control, '待开始')
      assert.equal(groupFilters.viewId, 'board-view-default')
      await assertReturnBoardFilters(control, groupFilters, threadId)
      await capture(control, 'group-thread-group-board-filtered-before-open.png')
      await click(control, `cloud-todo-card-${threadId}`)
      await wait(control, 'thread-back-to-board')
      await capture(control, 'group-thread-return-to-group-board.png')
      await click(control, 'thread-back-to-board')
      await wait(control, 'collaboration-board')
      await assertReturnBoardFilters(control, groupFilters, threadId)
      const groupReturned = new URL(JSON.parse(await control.command('snapshot', CONTENT)).location)
      assert.equal(groupReturned.searchParams.get('groupId'), groupId)
      assert.equal(groupReturned.searchParams.get('groupTab'), 'board')
      assert.equal(groupReturned.searchParams.get('groupStore'), 'local')
      assert.equal(groupReturned.searchParams.get('collaborationView'), 'groups')
      assert.equal(groupReturned.searchParams.get('threadId'), null)
      await capture(control, 'group-thread-group-board-filtered-restored.png')
      await control.command('select', scoped('cloud-board-group-filter'), { value: '' })
      await click(control, 'cloud-board-tag-filter-clear')
      await fill(control, 'cloud-board-search', '')
      await click(control, 'board-view-picker')
      await control.command('click', `[data-testid="${savedViewId}"]`)
      await wait(control, 'board-view-picker', { text: viewName })

      await click(control, 'group-tab-files')
      await click(control, 'cloud-folder-add')
      await fill(control, 'cloud-folder-name', '交付资料')
      await click(control, 'cloud-folder-create-confirm')
      await wait(control, 'cloud-file-browser-entry-shared-folder:交付资料')
      await capture(control, 'group-thread-files.png')

      // Only the model is simulated; the private Task and Group binding are real.
      const address = await createPrivateSession(control, 'GROUP_THREAD_PRIVATE_RUNTIME', true)
      const binding = await requestExecutor(
        control,
        'todos.bind',
        {
          project_id: groupId,
          item_id: threadId,
          task: { deviceId: address.deviceId, taskId: address.taskId },
        },
        uiTimeoutMs
      )
      assert.equal(binding.cloud_project_id, groupId)
      assert.equal(binding.loop_item_id, threadId)
      assert.equal(binding.task_user_id, 0)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('openWeworkScheme', 'body', {
        value: `wework://groups/local/${encodeURIComponent(groupId)}/threads/${encodeURIComponent(threadId)}`,
      })
      await wait(control, 'thread-room', { text: THREAD_TITLE })
      await control.command('waitFor', `${scoped('thread-room')} header`, { text: '待确认' })
      assert.equal(
        (await control.command('getText', scoped('group-message-list'))).includes(PRIVATE_RESULT),
        false
      )
      await reloadMainWindow(control)
      await wait(control, 'thread-room', { text: THREAD_TITLE })
      const bindings = await requestExecutor(
        control,
        'todos.bindings',
        { task_id: threadId },
        uiTimeoutMs
      )
      assert.ok(
        bindings.some(
          item =>
            item.id === binding.id &&
            item.cloud_project_id === groupId &&
            item.task_id === address.taskId
        )
      )
      assert.equal(
        (await control.command('getText', scoped('group-message-list'))).includes(PRIVATE_RESULT),
        false
      )
      await capture(control, 'group-thread-private-runtime-bound.png')

      // Project classification must preserve the Thread's real owning group.
      await click(control, 'collaboration-view-projects')
      await createLocalCollaborationProject(control, CONTENT, `事项聚合项目-${process.pid}`)
      const projectTestId = await control.command(
        'getAttribute',
        `${CONTENT} [data-testid^="collaboration-workspace-project-"][aria-current="page"]`,
        { value: 'data-testid' }
      )
      assert.ok(projectTestId?.startsWith('collaboration-workspace-project-'))
      const projectId = projectTestId.slice('collaboration-workspace-project-'.length)
      await selectCollaborationProjectView(control, CONTENT, 'milestones')
      await click(control, 'milestone-create')
      await fill(control, 'milestone-title', '跨群交付里程碑')
      await control.command('clickWhenEnabled', scoped('milestone-save'))
      const milestoneOpen = `${CONTENT} [data-testid^="milestone-open-ms-"]`
      await control.command('waitFor', milestoneOpen, { text: '跨群交付里程碑' })
      const milestoneId = (
        await control.command('getAttribute', milestoneOpen, { value: 'data-testid' })
      ).slice('milestone-open-'.length)
      await capture(control, 'group-thread-project-milestone-empty.png')
      await selectCollaborationProjectView(control, CONTENT, 'board')
      await control.command('openWeworkScheme', 'body', {
        value: `wework://groups/local/${encodeURIComponent(groupId)}/threads/${encodeURIComponent(threadId)}`,
      })
      await wait(control, 'thread-room', { text: THREAD_TITLE })
      await click(control, 'thread-settings')
      await control.command(
        'waitFor',
        `${scoped('thread-project-select')} option[value="${projectId}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('select', scoped('thread-project-select'), { value: projectId })
      await click(control, 'thread-project-apply')
      await control.command('waitFor', `${scoped('thread-project-apply')}[disabled]`, {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(await control.command('getValue', scoped('thread-project-select')), projectId)
      await capture(control, 'group-thread-project-link.png')
      await control.command(
        'waitFor',
        `${scoped('thread-settings-milestone')} option[value="${milestoneId}"]`
      )
      await control.command('select', scoped('thread-settings-milestone'), { value: milestoneId })
      await control.command('clickWhenEnabled', scoped('thread-settings-save'))
      await wait(control, 'thread-settings-panel', { text: '已保存' })
      await capture(control, 'group-thread-project-milestone-assigned.png')
      await click(control, 'thread-settings-close')
      await click(control, 'collaboration-view-projects')
      await control.command('clickWhenEnabled', scoped(projectTestId), {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await wait(control, `cloud-todo-card-${threadId}`, { text: THREAD_TITLE })
      await wait(control, `thread-source-group-${threadId}`, { text: GROUP_NAME })
      await capture(control, 'group-thread-project-aggregate.png')
      const projectDefault = await readSelectedView(control)
      assert.match(
        projectDefault.text,
        /默认/,
        'The initial project view must be the shared default'
      )
      await click(control, 'board-view-picker')
      await control.command('click', '[data-testid="board-view-new"]')
      await control.command('fill', '[data-testid="board-view-name"]', {
        value: '项目返回评审视图',
      })
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="board-view-set-default"]:checked')
        ),
        0,
        'Creating a temporary selected view must preserve the shared default'
      )
      await control.command('click', '[data-testid="board-view-save"]')
      await control.command('waitFor', '[data-testid="board-view-editor"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await wait(control, 'board-view-picker', { text: '项目返回评审视图' })
      const projectFilters = await selectReturnBoardFilters(control, '待确认')
      assert.notEqual(projectFilters.viewId, projectDefault.id)
      await assertReturnBoardFilters(control, projectFilters, threadId)
      await capture(control, 'group-thread-project-board-filtered-before-open.png')
      await click(control, `cloud-todo-card-${threadId}`)
      await wait(control, 'thread-room', { text: THREAD_TITLE })
      const opened = new URL(JSON.parse(await control.command('snapshot', CONTENT)).location)
      assert.equal(opened.searchParams.get('groupId'), groupId)
      assert.equal(opened.searchParams.get('threadId'), threadId)
      await capture(control, 'group-thread-project-opened.png')
      await wait(control, 'thread-back-to-board')
      await click(control, 'thread-back-to-board')
      await wait(control, `cloud-todo-card-${threadId}`, { text: THREAD_TITLE })
      await assertReturnBoardFilters(control, projectFilters, threadId)
      const projectReturned = new URL(
        JSON.parse(await control.command('snapshot', CONTENT)).location
      )
      assert.equal(projectReturned.searchParams.get('projectStore'), 'local')
      assert.equal(projectReturned.searchParams.get('projectId'), projectId)
      assert.equal(projectReturned.searchParams.get('collaborationView'), 'projects')
      await capture(control, 'group-thread-return-to-project-board.png')
      await control.command('select', scoped('cloud-board-group-filter'), { value: '' })
      await click(control, 'cloud-board-tag-filter-clear')
      await fill(control, 'cloud-board-search', '')
      await click(control, 'board-view-picker')
      await control.command('click', `[data-testid="${projectDefault.id}"]`)

      await click(control, 'collaboration-view-projects')
      await control.command('clickWhenEnabled', scoped(projectTestId), {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await click(control, 'collaboration-issue-create')
      await control.command('waitFor', '[data-testid="thread-create-group-select"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('select', '[data-testid="thread-create-group-select"]', {
        value: groupId,
      })
      await captureScreenshot(control, 'group-thread-project-create-group.png', 'body')
      await control.command('click', '[data-testid="thread-create-group-next"]')
      await control.command('waitFor', '[data-testid="thread-create-context"]', {
        timeoutMs: uiTimeoutMs,
        text: GROUP_NAME,
      })
      const projectThreadTitle = `从项目创建的群内事项-${process.pid}`
      await control.command('fill', '[data-testid="cloud-todo-title"]', {
        value: projectThreadTitle,
      })
      await control.command('clickWhenEnabled', scoped('issue-milestone'))
      await control.command(
        'clickWhenEnabled',
        `[data-testid="issue-milestone-option-${milestoneId}"]`
      )
      await captureScreenshot(control, 'group-thread-project-create-editor.png', 'body')
      await control.command('click', '[data-testid="cloud-todo-create-confirm"]')
      await wait(control, 'thread-room', { text: projectThreadTitle })
      const createdRoute = new URL(JSON.parse(await control.command('snapshot', CONTENT)).location)
      assert.equal(createdRoute.searchParams.get('groupId'), groupId)
      const createdThreadId = createdRoute.searchParams.get('threadId')
      assert.ok(createdThreadId && createdThreadId !== threadId)
      await capture(control, 'group-thread-project-created.png')
      await reloadMainWindow(control)
      await wait(control, 'thread-room', { text: projectThreadTitle })
      await click(control, 'collaboration-view-projects')
      await control.command('clickWhenEnabled', scoped(projectTestId), {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await wait(control, `cloud-todo-card-${createdThreadId}`, { text: projectThreadTitle })
      await wait(control, `thread-source-group-${createdThreadId}`, { text: GROUP_NAME })
      await capture(control, 'group-thread-project-created-persisted.png')

      await selectCollaborationProjectView(control, CONTENT, 'milestones')
      await wait(control, `milestone-${milestoneId}`, { text: '0%' })
      await click(control, `milestone-open-${milestoneId}`)
      await wait(control, `collaboration-issue-table-row-${threadId}`, { text: THREAD_TITLE })
      await wait(control, `collaboration-issue-table-row-${createdThreadId}`, {
        text: projectThreadTitle,
      })
      await capture(control, 'group-thread-project-milestone-members.png')
      await control.command('openWeworkScheme', 'body', {
        value: `wework://groups/local/${encodeURIComponent(groupId)}/threads/${encodeURIComponent(createdThreadId)}`,
      })
      await wait(control, 'thread-room', { text: projectThreadTitle })
      await click(control, 'thread-more')
      await control.command('click', '[data-testid="thread-menu-lifecycle"]')
      await wait(control, 'thread-room', { text: '已完成' })
      await click(control, 'collaboration-view-projects')
      await control.command('clickWhenEnabled', scoped(projectTestId), {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await selectCollaborationProjectView(control, CONTENT, 'milestones')
      await wait(control, `milestone-${milestoneId}`, { text: '50%' })
      await capture(control, 'group-thread-project-milestone-progress.png')
      await reloadMainWindow(control)
      await selectCollaborationProjectView(control, CONTENT, 'milestones')
      await wait(control, `milestone-${milestoneId}`, { text: '50%' })
      await click(control, `milestone-delete-${milestoneId}`)
      await control.command('clickWhenEnabled', scoped('milestone-delete-confirm'))
      await wait(control, `milestone-${milestoneId}`, { visible: false })
      for (const [id, title] of [
        [threadId, THREAD_TITLE],
        [createdThreadId, projectThreadTitle],
      ]) {
        await control.command('openWeworkScheme', 'body', {
          value: `wework://groups/local/${encodeURIComponent(groupId)}/threads/${encodeURIComponent(id)}`,
        })
        await wait(control, 'thread-room', { text: title })
        await click(control, 'thread-settings')
        await wait(control, 'thread-settings-milestone')
        assert.equal(await control.command('getValue', scoped('thread-settings-milestone')), '')
        await click(control, 'thread-settings-close')
      }
      await capture(control, 'group-thread-project-milestone-deleted.png')
      await click(control, 'collaboration-view-projects')
      await control.command('clickWhenEnabled', scoped(projectTestId), {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })

      await click(control, 'collaboration-primary-home')
      await wait(control, 'thread-creation-home')
      assert.equal(await control.command('getValue', scoped('thread-home-project')), '')
      await capture(control, 'group-thread-create-home.png')
      await click(control, 'thread-home-create')
      await control.command('waitFor', '[data-testid="thread-create-group-select"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('select', '[data-testid="thread-create-group-select"]', {
        value: groupId,
      })
      await control.command('click', '[data-testid="thread-create-group-next"]')
      await control.command('waitFor', '[data-testid="thread-create-context"]', {
        timeoutMs: uiTimeoutMs,
        text: '未关联项目',
      })
      const standaloneTitle = `无需项目的事项-${process.pid}`
      await control.command('fill', '[data-testid="cloud-todo-title"]', { value: standaloneTitle })
      assert.equal(
        await control.command('getAttribute', '[data-testid="cloud-todo-detail-description"]', {
          value: 'placeholder',
        }),
        '目标与验收标准'
      )
      await captureScreenshot(control, 'group-thread-create-without-project.png', 'body')
      await control.command('click', '[data-testid="cloud-todo-create-confirm"]')
      await wait(control, 'thread-room', { text: standaloneTitle })
      await click(control, 'thread-settings')
      assert.equal(await control.command('getValue', scoped('thread-project-select')), '')
      await capture(control, 'group-thread-created-without-project.png')
      await click(control, 'thread-settings-close')
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/local/retired-project/issues/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(messageId)}`,
      })
      await wait(control, 'thread-room', { text: THREAD_TITLE })
      await control.command(
        'waitFor',
        `${scoped(`group-message-${messageId}`)}[data-focused="true"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      const retained = new URL(JSON.parse(await control.command('snapshot', CONTENT)).location)
      assert.equal(retained.searchParams.get('groupId'), groupId)
      assert.equal(retained.searchParams.get('threadId'), threadId)
      assert.equal(retained.searchParams.get('commentId'), messageId)
      assert.equal(retained.searchParams.has('projectId'), false)
      await capture(control, 'group-thread-retained-project-link.png')
      await control.command('openWeworkScheme', 'body', {
        value: 'wework://boards/local/retired-project/issues/missing-thread',
      })
      await wait(control, 'thread-link-retry')
      await reloadMainWindow(control)
      await wait(control, 'thread-link-retry')
      await captureScreenshot(control, 'group-thread-retained-link-unavailable.png', CONTENT)
      await click(control, 'thread-link-back')
      await wait(control, 'collaboration-groups')
      await click(control, 'collaboration-view-projects')
      await wait(control, 'wework-collaboration-platform')
      await wait(control, 'thread-link-retry', { visible: false })
      await capture(control, 'group-thread-retained-link-recovered.png')
      await verifyLegacyMigration(control, groupId, address.taskId)
    },
  }
}
