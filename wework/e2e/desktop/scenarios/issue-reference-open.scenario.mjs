import assert from 'node:assert/strict'
import { createLocalCollaborationProject } from '../modules/workspace-flows.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'

export function createDesktopScenario({ uiTimeoutMs }) {
  return {
    async verify(control) {
      const projectName = `Issue reference-${process.pid}`
      await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, projectName)
      const projects = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      const project = projects.find(candidate => candidate.name === projectName)
      assert.ok(project, 'The local project was created')
      // Create outside the renderer so this Issue is absent from its loaded board snapshot.
      const issue = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: { title: 'UNLOADED_REFERENCE_ISSUE' },
        },
        uiTimeoutMs
      )
      assert.ok(issue.id)
      await control.command(
        'clickWhenEnabled',
        `${CONTENT} [data-testid="collaboration-issue-search-open"]`
      )
      await control.command('fill', `${CONTENT} [data-testid="cloud-global-search-input"]`, {
        value: issue.id,
      })
      await control.command(
        'clickWhenEnabled',
        `${CONTENT} [data-testid="cloud-global-search-open-issue"]`
      )
      await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail"]`, {
        text: 'UNLOADED_REFERENCE_ISSUE',
      })
      await control.command('waitFor', `${CONTENT} [data-testid="cloud-global-search"]`, {
        visible: false,
      })
    },
  }
}
