import assert from 'node:assert/strict'
import { createDesktopScenario as createExisting } from './collaboration-local-status-automation.scenario.mjs'
import { createIssueDelegationModel } from '../modules/issue-delegation-model.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { storyUntil } from '../modules/stand-in-source-story-evidence.mjs'
import { selectWorkspaceIssueAgent } from '../modules/workspace-agent-setup.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'
import { inCollaborationSidebar } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MARKER = `COLLABORATION_AGENT_DELEGATION_${process.pid}`
const ACK = '收到，我会完成检查后汇报。'
const RESULT = `${MARKER}_VERIFIED`
const PRIVATE = `${MARKER}_PRIVATE_CHILD_EVIDENCE`

/** Reuse the CI-owned app, project, Agent and execution environment. */
export async function createDesktopScenario(options) {
  const existing = await createExisting(options)
  const model = createIssueDelegationModel({
    marker: MARKER,
    acknowledgment: ACK,
    result: RESULT,
    privateEvidence: PRIVATE,
  })
  let active = false
  let issueId, projectId
  return {
    ...existing,
    handleHttp(...args) {
      return active ? model.handleHttp(...args) : existing.handleHttp(...args)
    },
    async verify(control) {
      await existing.verify(control)
      const fixture = existing.diagnostics().dispatch
      const rpc = (method, params = {}) =>
        requestExecutor(control, method, params, options.uiTimeoutMs)
      const project = (await rpc('projects.list')).find(row => row.name === fixture.project)
      assert.ok(project, 'Reuse the real local assignment project')
      projectId = project.id
      const source = (await rpc('chat_agents.list', { project_id: 'default-work-items' })).find(
        row => row.display_name === fixture.agent
      )
      assert.ok(source, 'Reuse the real workspace Agent')
      active = true
      await control.command(
        'clickWhenEnabled',
        inCollaborationSidebar(
          `[data-testid="collaboration-workspace-project-${projectId}"]`,
          CONTENT
        )
      )
      await selectCollaborationProjectView(control, CONTENT, 'board', options.uiTimeoutMs)
      const scoped = name => `${CONTENT} [data-testid="${name}"]`
      await control.command('clickWhenEnabled', scoped('collaboration-issue-create'))
      await control.command('fill', scoped('cloud-todo-title'), { value: MARKER })
      await control.command('fill', scoped('cloud-todo-detail-description'), {
        value: '检查项目并简洁汇报核实后的结果。',
      })
      await selectWorkspaceIssueAgent(
        control,
        scoped('cloud-todo-create-assignee'),
        source.id,
        options.uiTimeoutMs,
        'create'
      )
      await control.command('clickWhenEnabled', scoped('cloud-todo-create-confirm'))
      await control.command('waitFor', scoped('collaboration-issue-detail'), { text: MARKER })
      await storyUntil(
        async () => {
          const issue = (await rpc('todos.list', { project_id: projectId })).find(
            row => row.title === MARKER
          )
          issueId = issue?.id
          return issue
        },
        issue => issue?.status === 'in_review',
        options.modelResponseTimeoutMs,
        'Assigned Agent must finish through a real native subagent'
      )
      await control.command('waitFor', scoped('cloud-task-activity-list'), { text: RESULT })
      const activity = await control.command('getText', scoped('cloud-task-activity-list'))
      assert.ok(activity.includes(ACK))
      assert.ok(!activity.includes(PRIVATE), 'Raw child evidence must not become an Issue comment')
      assert.deepEqual(model.state, { spawned: true, childRan: true, completed: true })
      const executions = (
        await rpc('executions.list', { project_id: projectId, include_terminal: true })
      ).filter(row => row.loop_item_id === issueId)
      assert.equal(executions.length, 1, 'Subagents must not create extra Issue executions')
      assert.equal(executions[0].status, 'succeeded')
    },
    diagnostics() {
      return { existing: existing.diagnostics(), projectId, issueId, ...model.state }
    },
  }
}
