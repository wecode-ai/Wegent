import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { waitForClosedStartupSplash } from '../modules/native-window-state.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import { createSse, readRequestBody, streamingTextEvents } from '../modules/response-protocol.mjs'
import {
  COLLABORATION_EXP_RHYTHM_MARKER,
  COLLABORATION_EXP_RHYTHM_ROLE,
  assertUnchangedGeometry,
  createCollaborationExpRhythmFixture,
} from '../modules/collaboration-exp-rhythm.mjs'
import {
  assertMobileAssistantPriority,
  assertNativeWorkOpened,
  assertReducedStateMotion,
  assertStableStateGeometry,
  readTeam,
} from '../modules/collaboration-exp-state-motion.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const APP = `${ACTIVE} [data-testid="collaboration-exp-app"]`
const TAB = '[data-testid="workspace-tab-select-fixed-collaboration-exp"]'
const PROMPT = 'COLLABORATION_EXP_NATIVE_PRIVATE_CONVERSATION'
const DRAFT = 'COLLABORATION_EXP_UNSENT_PRIVATE_DRAFT'
const UNRELATED = 'COLLABORATION_EXP_OTHER_NATIVE_TURN_MUST_STAY_PRIVATE'
const ORDINARY = 'COLLABORATION_EXP_ORDINARY_ASSISTANT_QUESTION'
const PUBLIC = 'COLLABORATION_EXP_EXPLICIT_EDITED_SHARED_CONCLUSION'
const PRIVATE_INPUT = `${APP} [data-testid="collaboration-exp-private-conversation"] [data-testid="chat-message-input"]`
const testId = id => `${APP} [data-testid=${JSON.stringify(id)}]`

export const COLLABORATION_EXP_USER_STORIES = [
  'default-off-preserves-baseline-and-makes-no-targeted-business-requests',
  'deliberate-beta-toggle-and-fixed-tab-survive-reload',
  'local-and-cloud-issues-keep-their-canonical-source',
  'project-notifications-and-deep-links-reuse-one-experiment-tab',
  'assistant-tasks-project-timeline-private-discussion-work-in-three-viewports',
  'reduced-motion-keeps-real-team-and-task-rhythm-states-readable-without-layout-shifts',
  'ordinary-assistant-question-creates-no-project-issue',
  'demo-create-cancels-without-writes-and-persists-native-standalone-and-cloud-project-issues',
  'native-issue-details-edit-the-same-canonical-issue-and-refresh-the-timeline',
  'source-discussion-shows-only-the-proven-owned-native-turn',
  'edited-conclusion-publishes-exactly-once-and-rechecks-current-permission',
  'private-unsent-draft-and-query-survive-reload-and-native-restart',
  'disable-and-reenable-retain-experiment-data-and-old-collaboration',
]

/** Real executor, native conversation, local storage and cloud APIs; only model HTTP is synthetic. */
export function createDesktopScenario({
  workspacePath,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
  restartDesktopApp,
  resultDir,
}) {
  let cloud
  let cloudRuntime
  let cloudProject
  let cloudIssue
  let localProject
  let localIssue
  let secondIssue
  let conversation
  let cloudUser
  let workspace
  let ownerToken
  let sourceMessage
  let heldRhythmResponse
  let rhythmModelCalls = 0
  function finishRhythmResponse() {
    if (!heldRhythmResponse) return
    const { response, finish } = heldRhythmResponse
    if (!response.writableEnded) response.end(createSse(finish))
    heldRhythmResponse = undefined
  }
  async function request(path, body, options = {}) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        Authorization: `Bearer ${options.token ?? cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  const route = issue =>
    `/collaboration-exp?${new URLSearchParams({
      view: 'tasks',
      relevance: 'all',
      projectStore: 'local',
      projectId: localProject.id,
      projectScope: JSON.stringify(['local', localProject.id]),
      ...(issue ? { issueId: issue.id } : {}),
      future: 'keep',
    })}`
  const click = (control, selector) =>
    control.command('clickWhenEnabled', selector, { visible: true })
  async function assertSingleton(control, project, issue, store, expectedScope) {
    await control.command('waitFor', APP, { timeoutMs: workbenchReadyTimeoutMs })
    await control.command('waitFor', testId('collaboration-exp-pane-header-timeline'), {
      text: issue.title,
    })
    await control.command('waitFor', testId('collaboration-exp-timeline'))
    const snapshot = JSON.parse(await control.command('snapshot', APP))
    const params = new URL(snapshot.location).searchParams
    assert.equal(params.get('projectStore'), store)
    assert.equal(params.get('projectId'), String(project.id))
    assert.equal(params.get('issueId'), String(issue.id))
    assert.equal(params.get('future'), 'keep')
    if (expectedScope !== undefined) assert.equal(params.get('projectScope'), expectedScope)
    assert.equal(Number(await control.command('getElementCount', TAB)), 1)
  }
  async function assertNoOverflow(control, selector, width) {
    const [metrics] = JSON.parse(await control.command('getElementMetrics', selector))
    assert.ok(metrics?.width > 0, `${selector} must be visible`)
    assert.ok(metrics.viewportWidth <= width + 1)
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${selector} overflowed horizontally`)
  }
  async function openPrivate(control) {
    await click(control, testId(`collaboration-exp-task-discussion-${conversation.taskId}`))
    await control.command('waitFor', PRIVATE_INPUT, { visible: true })
  }
  async function assertDesktopPanes(control) {
    const metrics = async selector =>
      JSON.parse(await control.command('getElementMetrics', selector))
    const visible = rows => rows.filter(row => row.width > 0 && row.height > 0)
    const headers = visible(await metrics(`${APP} .experience-header`))
    assert.ok(headers.length >= 3, 'Desktop must retain the task, timeline and discussion panes')
    for (const header of headers) assert.equal(header.height, 60)
    const separators = visible(await metrics(`${APP} [role="separator"][data-separator]`))
    assert.ok(separators.length >= 2, 'Desktop pane boundaries must remain resizable')
    for (const separator of separators) assert.equal(separator.width, 8)
    const separator = `${APP} #collaboration-exp-resize-timeline-discussion`
    const timeline = testId('collaboration-exp-pane-timeline')
    const discussion = testId('collaboration-exp-pane-discussion')
    const sizes = async () => [
      (await metrics(timeline))[0].width,
      (await metrics(discussion))[0].width,
    ]
    const original = await sizes()
    await control.command('focus', separator)
    await control.command('press', separator, { key: 'ArrowRight' })
    const resized = await sizes()
    assert.ok(resized[0] > original[0] && resized[1] < original[1])
    assert.ok(Math.abs(resized[0] + resized[1] - original[0] - original[1]) < 2)
    await control.command('doubleClick', separator)
    const reset = await sizes()
    assert.ok(reset.every((width, index) => Math.abs(width - original[index]) < 2))
    await control.command('dragStart', separator, { target: timeline })
    try {
      const dragging = await sizes()
      assert.ok(Math.abs(dragging[0] - original[0]) > 1, 'The real drag must move before Escape')
      await control.command('press', separator, { key: 'Escape' })
      const cancelled = await sizes()
      assert.ok(cancelled.every((width, index) => Math.abs(width - original[index]) < 2))
      assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
    } finally {
      await control.command('dragEnd', separator, { target: timeline })
    }
  }
  return {
    requiresCloudEnvironment: true,
    requiresRemoteExecutor: false,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', {})
      cloudUser = await request('/api/users/me')
      const ownerName = `collaboration-exp-owner-${process.pid}`
      const password = 'collaboration-exp-permission-fixture'
      await request('/api/admin/users', {
        user_name: ownerName,
        password,
        role: 'user',
        auth_source: 'password',
      })
      ownerToken = (await request('/api/auth/login', { user_name: ownerName, password }))
        .access_token
      workspace = await request(
        '/api/v1/workspaces',
        { name: `Collaboration exp ${process.pid}` },
        { token: ownerToken }
      )
      await request(
        `/api/v1/workspaces/${workspace.id}/members`,
        { user_id: cloudUser.id, role: 'Developer' },
        { token: ownerToken }
      )
      cloudProject = await request(
        `/api/v1/workspaces/${workspace.id}/projects`,
        {
          name: `Collaboration exp cloud ${process.pid}`,
          task_provider: 'local',
          visibility: 'private',
        },
        { token: ownerToken }
      )
      cloudIssue = await request(`/api/v1/cloud-projects/${cloudProject.id}/loop-items`, {
        title: `Collaboration exp cloud Issue ${process.pid}`,
        assignee_user_id: cloudUser.id,
      })
    },
    setCloudEnvironment(environment) {
      cloudRuntime = environment
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const marker = [COLLABORATION_EXP_RHYTHM_MARKER, ORDINARY, UNRELATED, PROMPT].find(value =>
        JSON.stringify(body).includes(value)
      )
      if (!marker) return false
      const events = streamingTextEvents(
        `collaboration-exp-${Date.now()}`,
        `${marker}_COMPLETE`,
        'final_answer'
      )
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (marker === COLLABORATION_EXP_RHYTHM_MARKER) {
        assert.equal(
          ++rhythmModelCalls,
          1,
          'The rhythm extension must use only one native model turn'
        )
        assert.equal(heldRhythmResponse, undefined, 'One controlled native turn is sufficient')
        response.write(createSse(events.start))
        heldRhythmResponse = { response, finish: events.finish }
        return true
      }
      response.end(createSse(events.start) + createSse(events.finish))
      return true
    },
    async verify(control) {
      const initialPreferences = JSON.parse(await control.command('getAppPreferences', 'body'))
      let previousSize
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const gates = runtimeTransportGates(control)
      const rhythm = createCollaborationExpRhythmFixture(rpc, modelResponseTimeoutMs)
      const comments = () =>
        rpc('todos.comment.list', { project_id: localProject.id, task_id: localIssue.id })
      const localIssueIdentities = async () => {
        const projects = await rpc('projects.list', {})
        const issues = await Promise.all(
          projects.map(async project =>
            (await rpc('todos.list', { project_id: project.id })).map(
              issue => `${project.id}:${issue.id}`
            )
          )
        )
        return issues.flat().sort()
      }
      const nativeTaskIdentities = async () => {
        const work = JSON.parse(await control.command('getLocalRuntimeWork', 'body'))
        return Object.values(work.workspaces ?? {})
          .flatMap(workspace => workspace.tasks ?? [])
          .map(task => task.taskId ?? task.task_id)
          .sort()
      }
      try {
        await control.command('setAppPreferences', 'body', {
          value: JSON.stringify({
            collaborationExperienceEnabled: false,
            fixedWorkspaceTabs: [
              { id: 'fixed-task', kind: 'task' },
              { id: 'fixed-board', kind: 'board' },
              { id: 'fixed-agent', kind: 'agent' },
            ],
            startupWorkspaceTabId: 'fixed-task',
          }),
        })
        localProject = await rpc('projects.create', {
          name: `Collaboration exp local ${process.pid}`,
        })
        localIssue = await rpc('todos.create', {
          project_id: localProject.id,
          todo: {
            title: `Collaboration exp local Issue ${process.pid}`,
            description: 'Canonical local task timeline',
          },
        })
        secondIssue = await rpc('todos.create', {
          project_id: localProject.id,
          todo: { title: `Collaboration exp notification Issue ${process.pid}` },
        })
        const baseline = await rpc('todos.get', {
          project_id: localProject.id,
          task_id: localIssue.id,
        })
        for (const method of [
          'todos.list',
          'todos.get',
          'todos.comment.list',
          'todos.comment.create',
        ]) {
          await gates.arm({
            id: `flag-off-${method}`,
            kind: 'request',
            name: method,
            where: [
              {
                path:
                  method === 'todos.comment.create'
                    ? 'params.comment.project_id'
                    : 'params.project_id',
                equals: localProject.id,
              },
            ],
            hold: false,
          })
        }
        await control.command('navigate', 'body', { value: '/settings' })
        await control.command('waitFor', '[data-testid="general-settings-page"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              '[data-testid="general-fixed-tab-add"] option[value="fixed-collaboration-exp"]'
            )
          ),
          0
        )
        assert.equal(Number(await control.command('getElementCount', TAB)), 0)
        await control.command('openWeworkScheme', 'body', {
          value: `wework://collaboration-exp?projectStore=local&projectId=${localProject.id}&issueId=${localIssue.id}`,
        })
        const absent = JSON.parse(
          await control.command('sampleElementPresence', '[data-testid="collaboration-exp-app"]', {
            value: '500',
          })
        )
        assert.equal(absent.observed, false)
        assert.equal(await control.command('getRoute', 'body'), '/settings')
        for (const method of [
          'todos.list',
          'todos.get',
          'todos.comment.list',
          'todos.comment.create',
        ])
          assert.equal(
            await gates.read(`flag-off-${method}`),
            null,
            `Disabled experiment requested ${method}`
          )
        assert.deepEqual(
          await rpc('todos.get', { project_id: localProject.id, task_id: localIssue.id }),
          baseline
        )
        await gates.reset()
        await control.command('navigate', 'body', { value: '/todo' })
        assert.equal(await control.command('getRoute', 'body'), '/todo')
        await control.command('activateSystemNotification', 'body', {
          value: `wework://boards/local/${encodeURIComponent(localProject.id)}/issues/${encodeURIComponent(localIssue.id)}`,
        })
        await control.command('waitFor', `${ACTIVE} [data-testid="collaboration-issue-detail"]`, {
          text: localIssue.title,
        })
        assert.equal(Number(await control.command('getElementCount', TAB)), 0)

        await click(control, '[data-testid="workspace-tab-select-fixed-task"]')
        // Selecting a fixed tab restores its retained route, including the notification's board.
        await control.command('navigate', 'body', { value: '/' })
        await control.command('waitFor', `${ACTIVE} ${ACTIVE_WORKBENCH_SELECTOR}`, {
          visible: true,
        })
        assert.equal(await control.command('getRoute', 'body'), '/')
        await createSingleRootLocalProject(
          control,
          workspacePath,
          'Collaboration exp native conversation'
        )
        await selectE2EModel(control)
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
        await click(control, `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: `${PROMPT}_COMPLETE`, timeoutMs: modelResponseTimeoutMs }
        )
        const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        conversation = debug.workbench.currentRuntimeTask
        assert.ok(conversation?.deviceId && conversation.taskId)
        await waitForCompletedRuntimeTaskThread(control, conversation.taskId, uiTimeoutMs)
        const transcript = await rpc('runtime.tasks.transcript', { taskId: conversation.taskId })
        assert.equal(transcript.success, true)
        const sourceTurn = transcript.turns.at(-1)
        assert.ok(sourceTurn?.id, 'The source must use an actual persisted native turn')
        sourceMessage = await rpc('todos.comment.create', {
          comment: {
            project_id: localProject.id,
            task_id: localIssue.id,
            sender_type: 'user',
            sender_id: '0',
            sender_name: 'local',
            content: 'Discuss the first native result',
            metadata: {
              runtime_address: { deviceId: conversation.deviceId, taskId: conversation.taskId },
              runtime_turn_id: sourceTurn.id,
            },
          },
        })
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: UNRELATED })
        await click(control, `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`)
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: `${UNRELATED}_COMPLETE`,
            timeoutMs: modelResponseTimeoutMs,
          }
        )
        await waitForCompletedRuntimeTaskThread(control, conversation.taskId, uiTimeoutMs)
        const continued = await rpc('runtime.tasks.transcript', { taskId: conversation.taskId })
        assert.ok(
          continued.turns.length >= 2,
          'Privacy needs a real unrelated turn in the same conversation'
        )
        const foreignMessage = await rpc('todos.comment.create', {
          comment: {
            project_id: localProject.id,
            task_id: localIssue.id,
            sender_type: 'user',
            sender_id: '42',
            sender_name: 'Another participant',
            content: 'Other participant source',
            metadata: {
              runtime_address: { deviceId: conversation.deviceId, taskId: conversation.taskId },
              runtime_turn_id: sourceTurn.id,
            },
          },
        })
        await rpc('todos.bind', {
          project_id: localProject.id,
          item_id: localIssue.id,
          task: {
            deviceId: conversation.deviceId,
            taskId: conversation.taskId,
            taskTitle: 'Existing private task',
          },
        })

        await ensureExperimentalFeaturesEnabled(control)
        await control.command('navigate', 'body', { value: '/settings' })
        const toggle = '[data-testid="general-collaboration-experience-toggle"]'
        await control.command('waitFor', toggle)
        await control.command('scrollIntoView', toggle)
        await control.command('waitFor', toggle, { visible: true })
        await click(control, toggle)
        await control.command('waitFor', `${toggle}[aria-checked="true"]`)
        await control.command('scrollIntoView', '[data-testid="general-fixed-tab-add"]')
        await control.command('select', '[data-testid="general-fixed-tab-add"]', {
          value: 'fixed-collaboration-exp',
        })
        await control.command('waitFor', TAB)
        await control.command('navigate', 'body', { value: route(localIssue) })
        await assertSingleton(control, localProject, localIssue, 'local')
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              testId(
                `collaboration-exp-node-discussion-${foreignMessage.message_id}-${conversation.taskId}`
              )
            )
          ),
          0
        )
        await click(
          control,
          testId(
            `collaboration-exp-node-discussion-${sourceMessage.message_id}-${conversation.taskId}`
          )
        )
        await control.command('waitFor', testId('collaboration-exp-private-conversation'), {
          text: `${PROMPT}_COMPLETE`,
          timeoutMs: workbenchReadyTimeoutMs,
        })
        const sourceHistory = await control.command(
          'getText',
          testId('collaboration-exp-private-conversation')
        )
        assert.ok(
          !sourceHistory.includes(UNRELATED),
          'A source discussion must hide all unrelated native turns'
        )
        await click(control, testId('collaboration-exp-pane-header-discussion-back'))

        await control.command('activateSystemNotification', 'body', {
          value: `wework://boards/local/${encodeURIComponent(localProject.id)}/issues/${encodeURIComponent(secondIssue.id)}`,
        })
        await assertSingleton(
          control,
          localProject,
          secondIssue,
          'local',
          JSON.stringify(['local', localProject.id])
        )
        await control.command('openWeworkScheme', 'body', {
          value: `wework://boards/${cloudProject.id}/issues/${encodeURIComponent(cloudIssue.id)}`,
        })
        await assertSingleton(
          control,
          cloudProject,
          cloudIssue,
          'backend',
          JSON.stringify(['local', localProject.id])
        )
        await control.command('waitFor', APP, { text: cloudIssue.title })
        const actualCloudIssue = await request(`/api/v1/loop-items/${cloudIssue.id}`)
        assert.equal(actualCloudIssue.title, cloudIssue.title)
        const device = await cloudRuntime.waitForConnectedAppDevice()
        await request(`/api/v1/loop-items/${cloudIssue.id}/tasks`, {
          deviceId: device.execution_target_id,
          taskId: conversation.taskId,
          taskTitle: 'Canonical cloud private reference',
        })
        await control.command('navigate', 'body', { value: route(localIssue) })
        await control.command('navigate', 'body', {
          value: `/collaboration-exp?view=tasks&relevance=all&projectStore=backend&projectId=${cloudProject.id}&issueId=${cloudIssue.id}&future=keep`,
        })
        await control.command(
          'waitFor',
          `${testId(`collaboration-exp-task-group-${actualCloudIssue.status}`)} [data-testid=${JSON.stringify(`collaboration-exp-task-${cloudIssue.id}`)}]`
        )
        assert.equal(actualCloudIssue.assignee_user_id, cloudUser.id)
        await control.command('waitFor', testId(`collaboration-exp-task-${cloudIssue.id}`), {
          text: actualCloudIssue.assignee_name ?? String(cloudUser.id),
        })
        const cloudBindings = await request(`/api/v1/loop-items/${cloudIssue.id}/tasks`)
        assert.equal(cloudBindings.length, 1)
        assert.equal(cloudBindings[0].task_id, conversation.taskId)
        assert.equal(cloudBindings[0].task_user_id, cloudUser.id)
        await openPrivate(control)
        await request(
          `/api/v1/workspaces/${workspace.id}/members/${cloudUser.id}`,
          { role: 'Viewer' },
          { token: ownerToken, method: 'PATCH' }
        )
        assert.equal(
          (await request(`/api/v1/cloud-projects/${cloudProject.id}`)).access_role,
          'Viewer'
        )
        const cloudComments = await request(
          `/api/v1/cloud-projects/${cloudProject.id}/loop-items/${cloudIssue.id}/activity-comments`
        )
        await control.command('fill', testId('collaboration-exp-conclusion-text'), {
          value: PUBLIC,
        })
        await click(control, testId('collaboration-exp-conclusion-publish'))
        await control.command(
          'waitFor',
          `${testId('collaboration-exp-conclusion-form')} [role="alert"]`
        )
        assert.match(
          await control.command(
            'getText',
            `${testId('collaboration-exp-conclusion-form')} [role="alert"]`
          ),
          /permission|权限|无权发表评论/i
        )
        assert.equal(
          await control.command('getValue', testId('collaboration-exp-conclusion-text')),
          PUBLIC
        )
        assert.deepEqual(
          await request(
            `/api/v1/cloud-projects/${cloudProject.id}/loop-items/${cloudIssue.id}/activity-comments`
          ),
          cloudComments
        )
        await request(
          `/api/v1/workspaces/${workspace.id}/members/${cloudUser.id}`,
          { role: 'Developer' },
          { token: ownerToken, method: 'PATCH' }
        )
        assert.equal(
          (await rpc('todos.get', { project_id: localProject.id, task_id: localIssue.id })).title,
          localIssue.title
        )

        const createLogPath = join(resultDir, 'app.log')
        const createLogOffset = (await readFile(createLogPath, 'utf8')).length
        for (const [store, project] of [
          ['local', localProject],
          ['backend', cloudProject],
        ]) {
          await control.command('navigate', 'body', {
            value: `/collaboration-exp?view=tasks&relevance=all&projectStore=${store}&projectId=${project.id}&future=keep`,
          })
          const targetProjectId = store === 'local' ? 'default-work-items' : project.id
          const listIssues = () =>
            store === 'local'
              ? rpc('todos.list', { project_id: targetProjectId })
              : request(`/api/v1/cloud-projects/${targetProjectId}/loop-items`)
          const beforeCreate = await listIssues()
          await click(control, testId('collaboration-exp-task-create'))
          await control.command('waitFor', testId('collaboration-exp-create-dialog'), {
            visible: true,
          })
          await control.command('fill', testId('collaboration-exp-create-goal'), {
            value: `COLLABORATION_EXP_CANCELLED_${store}`,
          })
          await click(control, testId('collaboration-exp-create-cancel'))
          await control.command('waitFor', testId('collaboration-exp-create-dialog'), {
            visible: false,
          })
          assert.deepEqual(await listIssues(), beforeCreate, 'Cancel must perform no Issue write')

          const title = `COLLABORATION_EXP_CREATED_${store}_${process.pid}`
          await click(control, testId('collaboration-exp-task-create'))
          if (store === 'backend') {
            await click(control, testId('collaboration-exp-create-project'))
            await click(
              control,
              `[data-testid=${JSON.stringify(`collaboration-exp-create-project-option-${JSON.stringify([store, project.id])}`)}]`
            )
          }
          await control.command('fill', testId('collaboration-exp-create-goal'), { value: title })
          await control.command('fill', testId('collaboration-exp-create-summary'), {
            value: `Persisted through the real ${store} source`,
          })
          await click(control, testId('collaboration-exp-create-submit'))
          await control.command('waitFor', testId('collaboration-exp-create-dialog'), {
            visible: false,
          })
          const created = await waitForValue(
            listIssues,
            issues => issues.find(issue => issue.title === title),
            'The Demo create action must persist through its exact real source',
            uiTimeoutMs
          )
          assert.equal(created.cloud_project_id, targetProjectId)
          assert.equal(created.assignee_user_id, store === 'local' ? 0 : cloudUser.id)
          assert.equal(created.description, `Persisted through the real ${store} source`)
          assert.equal((await listIssues()).filter(issue => issue.title === title).length, 1)
          await control.command('waitFor', testId('collaboration-exp-pane-header-timeline'), {
            text: title,
          })
          const params = new URL(JSON.parse(await control.command('snapshot', APP)).location)
            .searchParams
          assert.equal(params.get('projectStore'), store)
          assert.equal(params.get('projectId'), created.cloud_project_id)
          assert.equal(params.get('issueId'), created.id)
          await click(control, testId('collaboration-exp-header-details'))
          const detailTitle = testId('cloud-todo-detail-title')
          await control.command('waitFor', detailTitle, { visible: true })
          assert.equal(await control.command('getValue', detailTitle), title)
          await control.command('fill', detailTitle, { value: `${title}_EDITED` })
          await control.command('press', detailTitle, { key: 'Enter' })
          const edited = await waitForValue(
            listIssues,
            issues =>
              issues.find(issue => issue.id === created.id && issue.title === `${title}_EDITED`),
            'The existing native editor must save the same canonical Issue',
            uiTimeoutMs
          )
          assert.equal(edited.id, created.id)
          assert.ok(edited.version > created.version)
          await control.command('waitFor', testId('collaboration-exp-pane-header-timeline'), {
            text: edited.title,
          })
          await click(control, testId('collaboration-exp-pane-header-issue-details-back'))
          await control.command('waitFor', testId('collaboration-exp-issue-details'), {
            visible: false,
          })
          assert.equal((await listIssues()).filter(issue => issue.id === created.id).length, 1)
          if (store === 'backend') {
            await request(`/api/v1/loop-items/${created.id}`, undefined, { method: 'DELETE' })
            assert.equal(
              (await listIssues()).some(issue => issue.id === created.id),
              false
            )
          }
        }
        assert.doesNotMatch(
          (await readFile(createLogPath, 'utf8')).slice(createLogOffset),
          /\[renderer-(?:warning|error)\]/,
          'Real create, cancel and native Issue detail operations must emit no renderer warnings or errors'
        )

        await control.command('navigate', 'body', { value: '/collaboration-exp?view=assistant' })
        const assistantInput = testId('collaboration-exp-assistant-input')
        await control.command('waitFor', assistantInput, { visible: true })
        await selectE2EModel(control, undefined, undefined, APP)
        const beforeLocal = await localIssueIdentities()
        const beforeCloud = await request(`/api/v1/cloud-projects/${cloudProject.id}/loop-items`)
        const beforeShared = await comments()
        await control.command('fill', assistantInput, { value: ORDINARY })
        await click(control, testId('collaboration-exp-assistant-send'))
        await control.command('waitFor', testId('collaboration-exp-assistant-conversation'), {
          text: `${ORDINARY}_COMPLETE`,
          timeoutMs: modelResponseTimeoutMs,
        })
        assert.deepEqual(
          await localIssueIdentities(),
          beforeLocal,
          'Ordinary assistant questions must not create project Issues'
        )
        assert.deepEqual(
          await request(`/api/v1/cloud-projects/${cloudProject.id}/loop-items`),
          beforeCloud
        )
        assert.deepEqual(
          await comments(),
          beforeShared,
          'Ordinary assistant conversation must remain private'
        )

        const { runningIssue, address: runningAddress } = await rhythm.prepare(
          localProject,
          secondIssue,
          cloudUser.id
        )

        const logPath = join(resultDir, 'app.log')
        const logOffset = (await readFile(logPath, 'utf8')).length
        let lightStructure
        let lightColors
        for (const [name, width, height, appearanceMode] of [
          ['wide-light', 1440, 900, 'light'],
          ['wide-dark', 1440, 900, 'dark'],
          ['mobile-light', 390, 844, 'light'],
        ]) {
          const oldSize = await control.command('setMainWindowSize', 'body', {
            value: JSON.stringify({ width, height }),
          })
          previousSize ??= oldSize
          await control.command('setAppPreferences', 'body', {
            value: JSON.stringify({ appearanceMode }),
          })
          await control.command('waitFor', `html[data-theme="${appearanceMode}"]`)
          await control.command('navigate', 'body', { value: route() })
          await click(control, testId('collaboration-exp-navigation-assistant'))
          await control.command('setReducedMotion', 'body', { value: 'no-preference' })
          const relay = testId('collaboration-exp-team-relay')
          const runningRole = `${relay} [data-assistant-id="${COLLABORATION_EXP_RHYTHM_ROLE}"]`
          await control.command('waitFor', `${runningRole}[data-state="running"]`, {
            visible: true,
          })
          const teamBefore = await readTeam(control, relay)
          const boxesBefore = JSON.parse(await control.command('getElementMetrics', relay))
          await control.command('setReducedMotion', 'body', { value: 'reduce' })
          await assertReducedStateMotion(control, relay)
          assert.deepEqual(await readTeam(control, relay), teamBefore)
          assertUnchangedGeometry(
            boxesBefore,
            JSON.parse(await control.command('getElementMetrics', relay)),
            'Reduced-motion team'
          )
          await assertStableStateGeometry(control, relay)
          if (width === 390) {
            await assertMobileAssistantPriority(
              control,
              testId,
              runningRole,
              localProject.id,
              localIssue.id
            )
            await assertNoOverflow(control, testId('collaboration-exp-assistant-home'), width)
          }
          await captureScreenshot(control, `collaboration-exp-team-${name}.png`, APP)
          if (name === 'wide-light') {
            await control.command('waitFor', testId('collaboration-exp-assistant-current'), {
              visible: true,
              text: runningIssue.title,
            })
            await click(control, testId('collaboration-exp-assistant-current'))
            await assertNativeWorkOpened(control, runningAddress, uiTimeoutMs)
            await control.command('navigate', 'body', { value: route() })
            await control.command('waitFor', APP, { visible: true })
          }
          await click(control, testId('collaboration-exp-navigation-tasks'))
          await control.command('waitFor', `${runningRole}[data-state="running"]`, {
            visible: true,
          })
          assert.deepEqual(await readTeam(control, relay), teamBefore)
          await assertReducedStateMotion(control, relay)
          for (const state of ['waiting', 'running', 'completed'])
            await control.command('waitFor', testId(`collaboration-exp-task-rhythm-${state}`), {
              text: '1',
            })
          for (const state of ['waiting', 'running', 'completed'])
            assert.equal(
              await control.command('getText', testId(`collaboration-exp-task-rhythm-${state}`)),
              '1'
            )
          await control.command('waitFor', testId('collaboration-exp-task-rhythm-current'), {
            text: runningIssue.title,
          })
          await assertStableStateGeometry(control, testId('collaboration-exp-task-rhythm'))
          await captureScreenshot(control, `collaboration-exp-rhythm-${name}.png`, APP)
          if (name === 'wide-light') {
            await click(control, testId('collaboration-exp-filter-status'))
            await click(control, '[data-testid="collaboration-exp-filter-status-option-completed"]')
            await control.command('waitFor', testId('collaboration-exp-clear-status'), {
              visible: true,
            })
            for (const [state, expected] of [
              ['waiting', '0'],
              ['running', '0'],
              ['completed', '1'],
            ]) {
              await control.command('waitFor', testId(`collaboration-exp-task-rhythm-${state}`), {
                text: expected,
              })
              assert.equal(
                await control.command('getText', testId(`collaboration-exp-task-rhythm-${state}`)),
                expected
              )
            }
            await control.command('waitFor', testId('collaboration-exp-task-rhythm-current'), {
              visible: false,
            })
            assert.equal(
              Number(
                await control.command(
                  'getElementCount',
                  testId('collaboration-exp-task-rhythm-current')
                )
              ),
              0
            )
            assert.deepEqual(await readTeam(control, relay), teamBefore)
            await click(control, testId('collaboration-exp-clear-status'))
            await control.command('waitFor', testId('collaboration-exp-clear-status'), {
              visible: false,
            })
            for (const state of ['waiting', 'running', 'completed']) {
              await control.command('waitFor', testId(`collaboration-exp-task-rhythm-${state}`), {
                text: '1',
              })
              assert.equal(
                await control.command('getText', testId(`collaboration-exp-task-rhythm-${state}`)),
                '1'
              )
            }
            await control.command('waitFor', testId('collaboration-exp-task-rhythm-current'), {
              visible: true,
              text: runningIssue.title,
            })
            const beforeManage = await nativeTaskIdentities()
            const beforeManageIssues = await localIssueIdentities()
            await click(control, runningRole)
            await control.command('waitFor', `${ACTIVE} [data-testid="stand-in-role-name"]`, {
              visible: true,
            })
            assert.equal(
              await control.command('getValue', `${ACTIVE} [data-testid="stand-in-role-name"]`),
              'Integration assistant'
            )
            assert.deepEqual(await nativeTaskIdentities(), beforeManage)
            assert.deepEqual(await localIssueIdentities(), beforeManageIssues)
            await control.command('navigate', 'body', { value: route() })
            await control.command('waitFor', `${runningRole}[data-state="running"]`, {
              visible: true,
            })
          }
          await click(control, testId('collaboration-exp-task-rhythm-current'))
          await assertSingleton(control, localProject, runningIssue, 'local')
          await click(control, testId('collaboration-exp-pane-header-timeline-back'))
          await control.command('waitFor', testId(`collaboration-exp-task-${localIssue.id}`), {
            visible: true,
          })
          await click(control, testId(`collaboration-exp-task-project-${localIssue.id}`))
          await click(control, testId('collaboration-exp-project-plan'))
          await control.command(
            'waitFor',
            testId('collaboration-exp-project-plan') + '[aria-current="page"]'
          )
          await assertReducedStateMotion(control, APP)
          await click(control, testId('collaboration-exp-pane-header-project-back'))
          await click(control, testId(`collaboration-exp-task-${localIssue.id}`))
          await openPrivate(control)
          await control.command('fill', PRIVATE_INPUT, { value: DRAFT })
          assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
          await assertNoOverflow(control, APP, width)
          await assertNoOverflow(control, testId('collaboration-exp-private-pane'), width)
          if (width === 1440) {
            const structure = JSON.parse(await control.command('snapshot', APP))
              .testIds.filter(id => id.startsWith('collaboration-exp-'))
              .sort()
            const colors = await Promise.all(
              ['color', 'background-color'].map(value =>
                control.command('getComputedStyleValue', APP, { value })
              )
            )
            if (appearanceMode === 'light') {
              lightStructure = structure
              lightColors = colors
            } else {
              assert.deepEqual(structure, lightStructure)
              assert.notDeepEqual(colors, lightColors)
            }
            await assertDesktopPanes(control)
          } else {
            const headers = JSON.parse(
              await control.command('getElementMetrics', `${APP} .experience-header`)
            ).filter(row => row.width > 0)
            assert.equal(headers.length, 1, 'Mobile must show only the current layer')
            await click(control, testId('collaboration-exp-pane-header-discussion-back'))
            await click(control, testId('collaboration-exp-pane-header-timeline-back'))
            await click(control, testId(`collaboration-exp-task-${localIssue.id}`))
            await openPrivate(control)
            assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
          }
          await captureScreenshot(control, `collaboration-exp-${name}.png`, APP)
        }
        finishRhythmResponse()
        await rhythm.assertCompleted(control)
        assert.doesNotMatch(
          (await readFile(logPath, 'utf8')).slice(logOffset),
          /\[renderer-(?:warning|error)\]/,
          'The three-viewport main path must emit no renderer warnings or errors'
        )
        const beforePublish = await comments()
        await control.command('fill', testId('collaboration-exp-conclusion-text'), {
          value: PUBLIC,
        })
        await gates.arm({
          id: 'publish-fresh-issue',
          kind: 'request',
          name: 'todos.get',
          where: [{ path: 'params.task_id', equals: localIssue.id }],
        })
        await click(control, testId('collaboration-exp-conclusion-publish'))
        await gates.wait('publish-fresh-issue')
        await control.command('submit', testId('collaboration-exp-conclusion-form'))
        assert.deepEqual(
          await comments(),
          beforePublish,
          'Publication must wait for its fresh permission check'
        )
        await gates.release('publish-fresh-issue')
        const published = await waitForValue(
          comments,
          rows => rows.filter(row => row.content === PUBLIC).length === 1 && rows,
          'One explicit conclusion must reach the original Issue',
          uiTimeoutMs
        )
        assert.equal(published.length, beforePublish.length + 1)
        const shared = JSON.stringify(published)
        for (const secret of [DRAFT, UNRELATED, `${PROMPT}_COMPLETE`, ORDINARY])
          assert.ok(!shared.includes(secret), 'Publication must contain only the edited conclusion')
        assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
        await gates.reset()
        const selected = new URL(JSON.parse(await control.command('snapshot', APP)).location)
          .searchParams
        assert.ok(selected.get('discussion'))
        await reloadMainWindow(control, 'Restore experiment project, Issue and private draft')
        await control.command('waitFor', PRIVATE_INPUT, {
          visible: true,
          timeoutMs: workbenchReadyTimeoutMs,
        })
        assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
        await assertSingleton(control, localProject, localIssue, 'local')
        assert.equal(
          new URL(JSON.parse(await control.command('snapshot', APP)).location).searchParams.get(
            'discussion'
          ),
          selected.get('discussion')
        )
        await control.command('setAppPreferences', 'body', {
          value: JSON.stringify({ startupWorkspaceTabId: 'fixed-collaboration-exp' }),
        })
        assert.ok(
          restartDesktopApp,
          'The collaboration experience checkpoint requires a real Electron restart'
        )
        await restartDesktopApp()
        await waitForClosedStartupSplash(control)
        await control.command('waitFor', PRIVATE_INPUT, {
          visible: true,
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await assertSingleton(control, localProject, localIssue, 'local')
        assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
        const restored = new URL(JSON.parse(await control.command('snapshot', APP)).location)
          .searchParams
        for (const key of [
          'view',
          'projectScope',
          'projectStore',
          'projectId',
          'issueId',
          'discussion',
          'future',
        ])
          assert.equal(restored.get(key), selected.get(key), `Restart lost ${key}`)

        await control.command('setAppPreferences', 'body', {
          value: JSON.stringify({ collaborationExperienceEnabled: false }),
        })
        await reloadMainWindow(control, 'Roll back collaboration experience preview')
        assert.equal(Number(await control.command('getElementCount', TAB)), 0)
        assert.equal(
          Number(await control.command('getElementCount', '[data-testid="collaboration-exp-app"]')),
          0
        )
        await click(control, '[data-testid="workspace-tab-select-fixed-board"]')
        assert.equal(await control.command('getRoute', 'body'), '/todo')
        await control.command('navigate', 'body', {
          value: `/todo?projectStore=local&projectId=${localProject.id}&issueId=${localIssue.id}`,
        })
        await control.command('waitFor', `${ACTIVE} [data-testid="collaboration-issue-detail"]`, {
          text: PUBLIC,
        })
        assert.equal((await comments()).filter(row => row.content === PUBLIC).length, 1)
        assert.equal((await rpc('todos.bindings', { task_id: localIssue.id })).length, 1)
        await control.command('setAppPreferences', 'body', {
          value: JSON.stringify({ collaborationExperienceEnabled: true }),
        })
        await click(control, TAB)
        await control.command('waitFor', PRIVATE_INPUT, { visible: true })
        assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
      } finally {
        finishRhythmResponse()
        try {
          await rhythm.cleanup()
        } finally {
          await gates.reset()
          await control.command('setReducedMotion', 'body', { value: 'system' })
          if (workspace && cloudUser)
            await request(
              `/api/v1/workspaces/${workspace.id}/members/${cloudUser.id}`,
              { role: 'Developer' },
              { token: ownerToken, method: 'PATCH' }
            )
          if (previousSize)
            await control.command('setMainWindowSize', 'body', { value: previousSize })
          await control.command('setAppPreferences', 'body', {
            value: JSON.stringify({
              collaborationExperienceEnabled: initialPreferences.collaborationExperienceEnabled,
              experimentalFeaturesEnabled: initialPreferences.experimentalFeaturesEnabled,
              fixedWorkspaceTabs: initialPreferences.fixedWorkspaceTabs,
              startupWorkspaceTabId: initialPreferences.startupWorkspaceTabId,
              appearanceMode: initialPreferences.appearanceMode,
            }),
          })
        }
      }
    },
    diagnostics() {
      return { localProject, localIssue, secondIssue, cloudProject, cloudIssue, conversation }
    },
  }
}
