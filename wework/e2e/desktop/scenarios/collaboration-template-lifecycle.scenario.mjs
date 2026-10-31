import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
  openProjectAgentCreator,
  selectProjectRunnerModel,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  functionCall,
  mcpToolRequestEvents,
  readRequestBody,
  responseCompleted,
  responseCreated,
  requestContainsToolOutput,
  selectShellToolCommand,
  toolOutputText,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = name => `${CONTENT} [data-testid="${name}"]`
const MARKER = `TEMPLATE_LIFECYCLE_${process.pid}`
const PROJECT = `产品全流程验收-${process.pid}`
const ISSUE = '优化协作项目和小组模板创建引导'
const LEADER = '产品交付负责人'
const WORKER = '跨职能执行智能体'
const STAGES = ['产品定义', '体验设计', '技术方案', '研发实现', '测试验收', '发布交付']
const REQUIREMENT = `${MARKER}\n协作项目和小组支持模板快速创建。Wework 在协作界面最后一个入口发现模板，Wegent 在能力商店发现同一批模板，后端以 Kind 保存。支持 YAML 导入、项目设置中保存和导出，离线可用内置模板。负责人默认智能体，新建任务自动交给小组，看板以标签表示阶段。产品、设计、研发、测试到交付完整闭环，发布前人工确认。`

function respond(response, id, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
}

async function until(read, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  let actual
  while (Date.now() < deadline) {
    actual = await read()
    if (predicate(actual)) return actual
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(actual)}`)
}

async function addAgent(control, name, prompt, timeoutMs) {
  await openProjectAgentCreator(control, selector('project-agent-add'), timeoutMs)
  await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
    value: name,
  })
  await selectProjectRunnerModel(control, timeoutMs)
  await control.command('click', '[data-testid="cloud-project-chat-agent-editor-advanced-toggle"]')
  await control.command('fill', '[data-testid="cloud-project-chat-agent-system-prompt"]', {
    value: prompt,
  })
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
    visible: false,
    timeoutMs,
  })
}

function shellEvents(body, callId, command, workspacePath) {
  const namespace = [
    ...(body.tools ?? []),
    ...(body.input ?? [])
      .filter(item => item.type === 'additional_tools')
      .flatMap(item => item.tools ?? []),
  ].find(tool => tool.type === 'namespace' && tool.tools?.some(child => child.name === 'exec'))
  if (namespace)
    return [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: callId,
          type: 'custom_tool_call',
          call_id: callId,
          namespace: namespace.name,
          name: 'exec',
          input: `text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: workspacePath, yield_time_ms: 1000 })}))`,
        },
      },
    ]
  const selection = selectShellToolCommand(body, command, workspacePath)
  return functionCall(callId, selection.name, selection.arguments)
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`

export function createDesktopScenario({
  resultDir,
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  recordScenarioRequest,
}) {
  let active = false
  let control
  let projectId
  let task
  let group
  let workerId
  let phase = 0
  let memberStarted = -1
  let completed = 0
  const releases = STAGES.map(() => {
    let release
    const promise = new Promise(resolve => {
      release = resolve
    })
    return { promise, release }
  })
  let releaseManager
  const managerStart = new Promise(resolve => {
    releaseManager = resolve
  })
  const phaseWorkspaces = []
  const evidence = []
  const click = name => control.command('click', selector(name))
  const wait = (name, text) =>
    control.command('waitFor', selector(name), { text, timeoutMs: uiTimeoutMs })
  const capture = async (name, description) => {
    await captureScreenshot(control, `template-lifecycle-${name}.png`, CONTENT)
    evidence.push({ file: `template-lifecycle-${name}.png`, description })
  }
  const currentTask = () =>
    requestExecutor(control, 'todos.get', { project_id: projectId, task_id: task.id }, uiTimeoutMs)

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      recordScenarioRequest('template_lifecycle', { body })
      const text = JSON.stringify(body)
      const id = `${MARKER}-${Date.now()}`
      if (['prewarm', 'compaction'].includes(codexRequestKind(body))) {
        respond(response, id, [assistantMessage('Ready')])
        return true
      }
      if (!text.includes(MARKER)) {
        respond(response, id, [])
        return true
      }
      if (text.includes(`${MARKER}_MEMBER`)) {
        const index = STAGES.findIndex((_, i) => text.includes(`阶段验收-${i + 1}`))
        assert.ok(index >= 0, 'Member task must identify its workflow stage')
        const context = (body.input ?? [])
          .flatMap(item => item.content ?? [])
          .map(part => part.text ?? '')
          .join('\n')
        const nativeWorkspace = context.match(/<cwd>([^<]+)<\/cwd>/)?.[1]
        assert.ok(
          nativeWorkspace?.startsWith(resultDir + sep),
          'The native workspace must belong to this isolated test'
        )
        phaseWorkspaces[index] = nativeWorkspace
        memberStarted = index
        await releases[index].promise
        const callId = `${MARKER}-artifact-${index}`
        if (requestContainsToolOutput(body, callId)) {
          const output = toolOutputText(body, callId)
          assert.match(
            output,
            /Exit code: 0|exit_code\W*0|Process exited with code 0/,
            'The real shell must succeed'
          )
          assert.match(output, new RegExp(`STAGE_${index}_VERIFIED`))
          completed = index + 1
          respond(response, id, [
            assistantMessage(
              `${STAGES[index]}已完成，交付 evidence-${index + 1}.md，验收命令成功。`
            ),
          ])
          return true
        }
        const content = `# ${STAGES[index]}\n\n${REQUIREMENT}\n\n验收目标：${
          [
            '明确入口、离线模板、共享配置和自动分工的验收标准。',
            '模板发现→角色绑定→项目设置导入→阶段标签看板→人工确认，文案面向用户。',
            'Kind 保存可移植配置，groupKey 在导入后解析为新小组 ID，复用自动处理规则和标签视图。',
            '验证真实内置配置包含智能体负责人、任务创建触发器和六阶段标签。',
            '执行配置约束检查，确认六阶段、负责人默认类型、逻辑分配目标均一致。',
            '汇总六阶段证据，提交待确认；经人工验收后再发布，保留原有视图及业务标签。',
          ][index]
        }\n`
        const canonicalPath = fileURLToPath(
          new URL('../../../../shared/data/collaboration-templates.json', import.meta.url)
        )
        const script = `const fs=require('node:fs'),a=require('node:assert/strict');const d=JSON.parse(fs.readFileSync(${JSON.stringify(canonicalPath)},'utf8'))[0].spec.resources.collaboration; a.equal(d.groups[0].roles[0].defaultKind,'agent');a.equal(d.project.taskAssignment.enabled,true);a.equal(d.project.taskAssignment.groupKey,d.groups[0].key);a.deepEqual(d.project.board.tags,${JSON.stringify(STAGES)});fs.writeFileSync(${JSON.stringify(`evidence-${index + 1}.md`)},${JSON.stringify(content)});console.log('STAGE_${index}_VERIFIED')`
        respond(
          response,
          id,
          shellEvents(body, callId, `node -e ${shellQuote(script)}`, nativeWorkspace)
        )
        return true
      }
      const index = phase
      if (index === 0) await managerStart
      if (index === STAGES.length) {
        const callId = `${MARKER}-review`
        if (requestContainsToolOutput(body, callId)) {
          respond(response, id, [assistantMessage('六阶段交付已汇总，请人工核验后完成需求。')])
          return true
        }
        const selection = mcpToolRequestEvents(body, {
          toolName: 'update_issue_status',
          searchCallId: `${callId}-search`,
          toolCallId: callId,
          argumentsValue: {
            status: 'in_review',
            reason: '六阶段成员交付及命令验收通过。',
            comment: '六阶段证据已汇总，等待人工验收，不自动发布。',
          },
        })
        respond(response, id, selection.events)
        return true
      }
      const tagCall = `${MARKER}-tag-${index}`
      const planCall = `${MARKER}-plan-${index}`
      if (requestContainsToolOutput(body, planCall)) {
        phase += 1
        respond(response, id, [assistantMessage(`${STAGES[index]}已分派，等待成员交付。`)])
        return true
      }
      if (!requestContainsToolOutput(body, tagCall)) {
        await until(
          () => task,
          value => Boolean(value),
          uiTimeoutMs,
          'Issue fixture has not observed the created task'
        )
        const latest = await currentTask()
        const selection = mcpToolRequestEvents(body, {
          toolName: 'update_board_item',
          searchCallId: `${tagCall}-search`,
          toolCallId: tagCall,
          argumentsValue: {
            space_id: projectId,
            item_id: task.id,
            item: { version: latest.version, tags: [STAGES[index]] },
          },
        })
        respond(response, id, selection.events)
        return true
      }
      const selection = mcpToolRequestEvents(body, {
        toolName: 'submit_workflow_plan',
        searchCallId: `${planCall}-search`,
        toolCallId: planCall,
        argumentsValue: {
          plan: {
            round_id: `${MARKER}-round-${index}`,
            summary: `${STAGES[index]}阶段验收`,
            items: [
              {
                assignment_id: `${MARKER}-assignment-${index}`,
                title: `阶段验收-${index + 1} ${STAGES[index]}`,
                instructions: `${MARKER}。对本需求完成${STAGES[index]}并提供可检查的交付文件和验收命令。`,
                assignee_type: 'agent',
                assignee_id: workerId,
                workflow_stage_id: group.stages[index].id,
              },
            ],
          },
        },
      })
      respond(response, id, selection.events)
      return true
    },
    async verify(appControl) {
      control = appControl
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await click('collaboration-tab-manage')
      await click('collaboration-project-settings-agents')
      await addAgent(
        control,
        LEADER,
        `${MARKER}_MANAGER。作为负责人按产品定义、体验设计、技术方案、研发实现、测试验收、发布交付协调成员，使用标签更新阶段，最终提交人工确认。`,
        uiTimeoutMs
      )
      await addAgent(
        control,
        WORKER,
        `${MARKER}_MEMBER。执行分配任务，实际运行验收命令并写入阶段交付文件。`,
        uiTimeoutMs
      )
      const projects = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      projectId = projects.find(project => project.name === PROJECT).id
      const agents = await requestExecutor(
        control,
        'chat_agents.list',
        { project_id: projectId },
        uiTimeoutMs
      )
      const leaderId = agents.find(
        agent => agent.name === LEADER || agent.display_name === LEADER
      ).id
      workerId = agents.find(agent => agent.name === WORKER || agent.display_name === WORKER).id
      await click('collaboration-project-settings-sharing')
      await control.command('clickWhenEnabled', selector('project-template-import'), {
        timeoutMs: uiTimeoutMs,
      })
      await click('template-details-product-lifecycle')
      await wait('template-project-defaults', '新')
      await capture('01-preview', '产品全流程模板说明智能体负责人、自动分配和阶段标签')
      await click('template-use')
      const leaderValue = await control.command('getValue', selector('template-role-main-role-0'))
      assert.ok(leaderValue.startsWith('agent:'), 'Default coordinator must be an agent')
      await control.command('select', selector('template-role-main-role-0'), {
        value: `agent:${leaderId}`,
      })
      for (let i = 1; i < 6; i++)
        await control.command('select', selector(`template-role-main-role-${i}`), {
          value: `agent:${workerId}`,
        })
      await capture('02-bindings', '负责人默认智能体，执行成员与负责人分离')
      await control.command('clickWhenEnabled', selector('template-bindings-apply'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', selector('template-bindings-apply'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      const configured = (await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)).find(
        project => project.id === projectId
      )
      group = configured.metadata.collaboration_groups[0]
      assert.equal(group.leader.kind, 'agent')
      const rule = configured.metadata.automatic_processing_rules.find(
        rule => rule.eventType === 'task.created'
      )
      assert.equal(rule.enabled, true)
      assert.equal(rule.targetId, group.id)
      const board = configured.metadata.board_views
      const view = board.views.find(view => view.id === board.default_view_id)
      assert.deepEqual(
        view.columns.filter(column => column.type === 'tag').map(column => column.value),
        STAGES
      )
      await capture('03-imported', '模板导入已有项目，配置完成')
      await click('collaboration-project-settings-automatic-processing')
      await wait('automatic-processing', '新任务')
      await capture('03-routing', '新任务自动处理规则指向模板创建的小组')
      await click('collaboration-project-settings-groups')
      await wait('collaboration-project-groups-page', '产品全流程小组')
      await capture('04-group', '实际持久化的协作小组')
      await click('collaboration-tab-board')
      await capture('05-board', '默认看板按六个阶段标签分列')
      active = true
      await control.command('clickWhenEnabled', selector('collaboration-issue-create'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', selector('cloud-todo-title'), { value: ISSUE })
      await control.command('fill', selector('cloud-todo-detail-description'), {
        value: REQUIREMENT,
      })
      await control.command('clickWhenEnabled', selector('cloud-todo-create-confirm'), {
        timeoutMs: uiTimeoutMs,
      })
      task = await until(
        () => requestExecutor(control, 'todos.list', { project_id: projectId }, uiTimeoutMs),
        items => items.some(item => item.title === ISSUE),
        uiTimeoutMs,
        'Issue was not created'
      )
      task = task.find(item => item.title === ISSUE)
      await until(
        currentTask,
        item => item.metadata?.collaboration_group?.id === group.id,
        modelResponseTimeoutMs,
        'New issue was not automatically assigned to the template group'
      )
      await capture('06-auto-assigned', '仅创建需求，系统自动分配给小组并启动负责人')
      releaseManager()
      for (let i = 0; i < STAGES.length; i++) {
        await until(
          () => memberStarted,
          value => value === i,
          modelResponseTimeoutMs,
          `Member did not start stage ${STAGES[i]}`
        )
        await until(
          currentTask,
          item => (item.tags ?? item.metadata?.tags ?? []).includes(STAGES[i]),
          uiTimeoutMs,
          'Stage tag was not persisted'
        )
        await wait('cloud-task-activity-list', `阶段验收-${i + 1}`)
        const assignmentEvent = await waitForTestIdByText(
          control,
          selector('cloud-task-activity-list'),
          'cloud-task-manager-event-',
          `阶段验收-${i + 1}`,
          uiTimeoutMs
        )
        await control.command('scrollIntoView', selector(assignmentEvent))
        await capture(`phase-${i + 1}-activity`, `${STAGES[i]}：负责人委派执行任务`)
        await click('cloud-todo-detail-close')
        await control.command('waitFor', selector(`cloud-todo-column-${view.columns[i + 1].id}`), {
          text: ISSUE,
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'scrollIntoView',
          selector(`cloud-todo-column-${view.columns[i + 1].id}`)
        )
        await capture(`phase-${i + 1}-board`, `${STAGES[i]}：标签驱动任务出现在对应看板列`)
        await click(`cloud-todo-card-${task.id}`)
        releases[i].release()
        await until(
          () => completed,
          count => count >= i + 1,
          modelResponseTimeoutMs,
          'Member command did not complete'
        )
        const delivery = await readFile(join(phaseWorkspaces[i], `evidence-${i + 1}.md`), 'utf8')
        assert.match(delivery, new RegExp(STAGES[i]))
        await writeFile(join(resultDir, `template-lifecycle-delivery-${i + 1}.md`), delivery)
      }
      await until(
        () => control.command('getValue', selector('cloud-todo-detail-status')),
        status => status === 'in_review',
        modelResponseTimeoutMs,
        'Manager did not submit review'
      )
      await control.command(
        'scrollIntoView',
        selector(`cloud-task-activity-review-actions-${task.id}`)
      )
      await capture('07-review', '六阶段完成，负责人提交待确认，等待人工验收')
      await control.command('clickWhenEnabled', selector(`cloud-task-activity-accept-${task.id}`), {
        timeoutMs: uiTimeoutMs,
      })
      await until(
        currentTask,
        item => item.status === 'completed',
        uiTimeoutMs,
        'Human acceptance was not persisted'
      )
      await control.command('waitFor', selector(`cloud-task-activity-accept-${task.id}`), { visible: false, timeoutMs: uiTimeoutMs })
      await capture('08-completed', '人工确认后需求完成')
      await writeFile(
        join(resultDir, 'template-lifecycle-evidence.json'),
        JSON.stringify(
          {
            projectId,
            issue: ISSUE,
            stages: STAGES,
            completed,
            workspaces: phaseWorkspaces,
            modelService:
              'deterministic protocol fixture; real Electron, Executor, MCP, storage and shell',
            screenshots: evidence,
          },
          null,
          2
        )
      )
    },
    async dispose() {
      releaseManager()
      releases.forEach(gate => gate.release())
    },
  }
}
