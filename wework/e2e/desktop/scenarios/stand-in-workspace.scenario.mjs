import { openProjectStandIn, discardStandInDraft } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = `分身工作区-${process.pid}`
const SOURCE = `分身代码-${process.pid}`
const MARKER = `STAND_IN_WORKSPACE_${process.pid}`
const USER_ID = 9001
const selector = id => `[data-testid=${JSON.stringify(id)}]`

async function clickVisibleControl(control, target) {
  const [bounds] = JSON.parse(await control.command('getElementMetrics', target))
  assert.ok(bounds.width > 0 && bounds.height > 0, `Control must be visible: ${target}`)
  await control.command('clickAt', 'body', {
    value: JSON.stringify({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }),
  })
}

export function createDesktopScenario({
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
}) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      await readRequestBody(request)
      const id = `stand-in-workspace-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(id), assistantMessage('已完成核对。'), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      await control.command('seedLocalProject', 'body', {
        value: JSON.stringify({ projectKey: SOURCE, name: SOURCE, path: workspacePath }),
      })
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      const projects = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      const project = projects.find(row => row.name === PROJECT)
      assert.ok(project)
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`, {
        connect: true,
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-auto"]')
      await control.command('waitFor', '[data-testid="stand-in-auto"][aria-checked="true"]')
      const beforeSave = await requestExecutor(
        control,
        'runtime.stand_in.get',
        { projectId: project.id, userId: USER_ID, projectStore: 'local' },
        uiTimeoutMs
      )
      assert.equal(beforeSave.enabled, false, 'Automatic handling must wait for explicit save')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      await control.command('click', '[data-testid="stand-in-advanced-open"]')
      assert.ok(
        await control.command('getValue', '[data-testid="stand-in-device"]'),
        'Current device must be selected by default'
      )
      await clickVisibleControl(
        control,
        '[data-testid="stand-in-settings"] [data-testid="project-work-button"]'
      )
      const option = await waitForTestIdByText(
        control,
        '[data-testid="project-work-menu"]',
        'project-option-',
        SOURCE
      )
      await captureScreenshot(control, 'stand-in-workspace-project-menu.png')
      await clickVisibleControl(control, selector(option))
      await control.command('click', '[data-testid="execution-mode-button"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="execution-mode-git-worktree-button"]'
      )
      await captureScreenshot(
        control,
        'stand-in-workspace-execution-settings.png',
        '[data-testid="stand-in-settings"]'
      )
      const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model, 'The real Codex model catalog must provide a default')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-settings"] [data-testid="model-selector-button"]'
      )
      const modelKey = JSON.stringify([model.runtime, model.provider, model.model_id])
      const modelSource =
        model.provider === 'openai' ? 'model-source-local-chatgpt' : 'model-source-custom'
      assert.equal(
        await control.command(
          'getElementCount',
          `[data-testid="${modelSource}"] ${selector(`model-option-${modelKey}`)}`
        ),
        '1',
        'The device model must appear under its local account source'
      )
      assert.equal(
        await control.command(
          'getElementCount',
          `[data-testid="model-source-cloud"] ${selector(`model-option-${modelKey}`)}`
        ),
        '0',
        'The device model must not appear under cloud models'
      )
      await control.command('clickWhenEnabled', selector(`model-option-${modelKey}`))
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-agent"]')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      await control.command(
        'click',
        '[data-testid="stand-in-settings"] [data-testid="add-context-button"]'
      )
      await control.command('click', '[data-testid="set-goal-button"]')
      await control.command('fill', '[data-testid="stand-in-prompt"]', { value: MARKER })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      let saved = await requestExecutor(
        control,
        'runtime.stand_in.get',
        { projectId: project.id, userId: USER_ID, projectStore: 'local' },
        uiTimeoutMs
      )
      assert.equal(saved.enabled, true)
      assert.equal(saved.goalMode, true)
      assert.equal(saved.workspace.workspacePath, workspacePath)
      assert.equal(saved.workspace.executionMode, 'git_worktree')
      assert.equal(saved.model.model_id, model.model_id)

      await control.command('click', `${CONTENT} [data-testid="collaboration-primary-stand-in"]`)
      await control.command('waitFor', '[data-testid="stand-in-overview"]')
      await control.command('waitFor', '[data-testid="stand-in-overview-status"]')
      await control.command('click', '[data-testid="stand-in-overview-role-default"]')
      await control.command('click', '[data-testid="stand-in-settings-open"]')
      await control.command('waitFor', '[data-testid="stand-in-advanced-open"]')
      await control.command('click', '[data-testid="stand-in-advanced-open"]')
      await control.command('waitFor', '[data-testid="project-work-button"]', {
        text: SOURCE,
      })
      await control.command('click', '[data-testid="stand-in-back"]')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      assert.equal(await control.command('getValue', '[data-testid="stand-in-prompt"]'), MARKER)
      // Goal persistence is asserted above; ordinary completion uses one model response.
      await control.command('click', '[data-testid="cancel-goal-draft-button"]')
      await control.command('click', '[data-testid="stand-in-auto"]')
      await control.command('waitFor', '[data-testid="stand-in-auto"][aria-checked="false"]')
      const beforeDisableSave = await requestExecutor(
        control,
        'runtime.stand_in.get',
        { projectId: project.id, userId: USER_ID, projectStore: 'local' },
        uiTimeoutMs
      )
      assert.equal(beforeDisableSave.enabled, true, 'Disabling must also wait for explicit save')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-overview-status"]', {
        text: '未开启',
      })
      saved = await requestExecutor(
        control,
        'runtime.stand_in.get',
        { projectId: project.id, userId: USER_ID, projectStore: 'local' },
        uiTimeoutMs
      )
      assert.equal(saved.goalMode, false)
      assert.equal(saved.enabled, false)
      await control.command('click', `${CONTENT} [data-testid="collaboration-primary-home"]`)
      await control.command('waitFor', '[data-testid="collaboration-issue-project-trigger"]', {
        visible: true,
      })
      await control.command('click', '[data-testid="collaboration-issue-project-trigger"]')
      await control.command('click', selector(`collaboration-issue-project-${project.id}`))
      await control.command('clickWhenEnabled', '[data-testid="issue-stand-in-select"]')
      await control.command('fill', '[data-testid="collaboration-home-issue-content"]', {
        value: MARKER,
      })
      await control.command('clickWhenEnabled', '[data-testid="collaboration-home-create-issue"]')
      const deadline = Date.now() + modelResponseTimeoutMs
      let task
      while (Date.now() < deadline) {
        const issues = await requestExecutor(
          control,
          'todos.list',
          { project_id: project.id },
          uiTimeoutMs
        )
        const issue = issues.find(issue => issue.title === MARKER)
        if (issue) {
          const bindings = await requestExecutor(
            control,
            'todos.bindings',
            { task_id: issue.id },
            uiTimeoutMs
          )
          assert.ok(
            bindings.length <= 1,
            'Manual and automatic creation must not duplicate an assignment'
          )
          if (bindings[0]) {
            const assigned = await requestExecutor(
              control,
              'todos.get',
              { project_id: project.id, task_id: issue.id },
              uiTimeoutMs
            )
            assert.equal(assigned.assignee_user_id, USER_ID)
            const result = await requestExecutor(
              control,
              'runtime.tasks.get',
              { taskId: bindings[0].task_id },
              uiTimeoutMs
            )
            task = result.task
            assert.notEqual(task?.status, 'failed', JSON.stringify(result))
            if (task?.status === 'done') break
          }
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      assert.equal(task?.status, 'done', JSON.stringify(task))
      assert.equal(task.workspaceKind, 'worktree')
      assert.notEqual(task.workspacePath, workspacePath)

      const skillDirectory = join(workspacePath, '.agents', 'skills', 'stand-in-catalog')
      await mkdir(skillDirectory, { recursive: true })
      try {
        await writeFile(
          join(skillDirectory, 'SKILL.md'),
          '---\nname: stand-in-catalog\ndescription: Verify the stand-in composer catalog.\n---\nInspect the current task.\n'
        )
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`)
        await control.command('clickWhenEnabled', '[data-testid="stand-in-auto"]')
        await control.command('fill', '[data-testid="stand-in-prompt"]', {
          value: `${MARKER}_UNSAVED /`,
        })
        await control.command(
          'waitFor',
          '[data-testid="slash-command-option-skill-stand-in-catalog"]'
        )
        await control.command('click', '[data-testid="slash-command-option-plugin-marketplace"]')
        await control.command(
          'waitFor',
          '[data-testid="workspace-tab-select-fixed-task"][aria-selected="true"]'
        )
        await control.command('waitFor', `${CONTENT} [data-testid="plugins-page-content"]`)
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        await control.command('waitFor', `${CONTENT} [data-testid="collaboration-primary-home"]`)
        await control.command('waitFor', '[data-testid="stand-in-prompt"]')
        assert.equal(
          (await control.command('getValue', '[data-testid="stand-in-prompt"]')).trim(),
          `${MARKER}_UNSAVED`
        )
        await discardStandInDraft(control)
      } finally {
        await rm(skillDirectory, { recursive: true, force: true })
      }
      const beforeProject = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      await createLocalCollaborationProject(control, CONTENT, '分身复用-' + process.pid)
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`)
      assert.equal(await control.command('getValue', '[data-testid="stand-in-prompt"]'), MARKER)
      const afterProject = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      assert.equal(
        afterProject.version,
        beforeProject.version,
        'Opening another project must reuse personal configuration without copying it'
      )
      assert.deepEqual(afterProject.roles[0].workspace, saved.workspace)
      assert.equal(afterProject.roles.length, beforeProject.roles.length)
      await control.command('click', '[data-testid="stand-in-cancel"]')
    },
  }
}
