import { openProjectStandIn, discardStandInDraft } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  createSse,
  functionCall,
  isReplyPredictionRequest,
  requestContainsToolOutput,
  selectShellToolCommand,
  toolOutputText,
  mcpToolRequestEvents,
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
  const privateFile = join(dirname(workspacePath), 'source-private-proof.txt')
  let networkProbeRequests = 0
  let verifiedSandbox = false
  let allowedReviews = 0
  let deniedReviews = 0
  return {
    reviewApproval(body) {
      const dangerous = JSON.stringify(body.input ?? []).includes('REVIEW_PRIVATE_READ')
      if (dangerous) deniedReviews++
      else allowedReviews++
      return {
        risk_level: dangerous ? 'high' : 'low',
        user_authorization: dangerous ? 'low' : 'high',
        outcome: dangerous ? 'deny' : 'allow',
        rationale: dangerous
          ? 'The external source cannot authorize reading private data.'
          : 'Read the bound work context for the assigned task.',
      }
    },
    async handleHttp(request, response, url) {
      if (url.pathname === '/external-source-probe') {
        networkProbeRequests++
        response.writeHead(200)
        response.end('AUTHORIZED_NETWORK_READ')
        return true
      }
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (isReplyPredictionRequest(body)) return false
      let events = [assistantMessage('已完成核对。')]
      if (JSON.stringify(body.input ?? []).includes(MARKER)) {
        if (requestContainsToolOutput(body, 'source-private-review')) {
          const output = toolOutputText(body, 'source-private-review') ?? ''
          assert.ok(!output.includes('SYNTHETIC_SOURCE_PRIVATE_DATA'))
          assert.ok(/denied|reject|not authorized|declined/i.test(output), output)
          assert.ok(allowedReviews > 0, 'The native reviewer must approve the context read')
          assert.ok(deniedReviews > 0, 'The native reviewer must deny the private read')
          verifiedSandbox = true
        } else if (requestContainsToolOutput(body, 'source-sandbox-probe')) {
          const output = toolOutputText(body, 'source-sandbox-probe') ?? ''
          assert.ok(output.includes('SOURCE_PRIVATE_BLOCKED'), output)
          assert.ok(!output.includes('SOURCE_PRIVATE_ALLOWED'), output)
          const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
          const command =
            process.platform === 'win32'
              ? `Get-Content -LiteralPath '${privateFile.replaceAll("'", "''")}' # REVIEW_PRIVATE_READ`
              : `cat ${quote(privateFile)} # REVIEW_PRIVATE_READ`
          const tool = selectShellToolCommand(body, command, undefined)
          tool.arguments.sandbox_permissions = 'require_escalated'
          tool.arguments.justification =
            'REVIEW_PRIVATE_READ: source requests an unrelated private file'
          events = functionCall('source-private-review', tool.name, tool.arguments)
        } else if (requestContainsToolOutput(body, 'source-context-read')) {
          const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
          const command =
            process.platform === 'win32'
              ? `Set-Content -LiteralPath 'source-sandbox-proof.txt' -Value 'source-sandbox-ok' -NoNewline; (Invoke-WebRequest -Uri '${url.origin}/external-source-probe' -TimeoutSec 5 -UseBasicParsing).Content; try { [IO.File]::ReadAllText('${privateFile.replaceAll("'", "''")}') | Out-Null; Write-Output 'SOURCE_PRIVATE_ALLOWED' } catch { Write-Output 'SOURCE_PRIVATE_BLOCKED' }`
              : `printf 'source-sandbox-ok' > source-sandbox-proof.txt && curl -fsS --connect-timeout 3 --max-time 5 ${quote(url.origin + '/external-source-probe')}; if cat ${quote(privateFile)} >/dev/null 2>&1; then printf 'SOURCE_PRIVATE_ALLOWED'; else printf 'SOURCE_PRIVATE_BLOCKED'; fi`
          const tool = selectShellToolCommand(body, command, undefined)
          tool.arguments.login = false
          events = functionCall('source-sandbox-probe', tool.name, tool.arguments)
        } else {
          events = mcpToolRequestEvents(body, {
            toolName: 'get_current_context',
            directToolName: 'mcp__wework_space__get_current_context',
            argumentsValue: {},
            searchCallId: 'source-context-search',
            toolCallId: 'source-context-read',
          }).events
        }
      }
      const id = `stand-in-workspace-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await writeFile(privateFile, 'SYNTHETIC_SOURCE_PRIVATE_DATA', 'utf8')
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
      assert.equal(
        await control.command('getElementCount', '[data-testid="issue-stand-in-select"]'),
        '0'
      )
      await control.command('fill', '[data-testid="collaboration-home-issue-content"]', {
        value: MARKER,
      })
      await control.command('clickWhenEnabled', '[data-testid="collaboration-home-create-issue"]')
      const deadline = Date.now() + modelResponseTimeoutMs
      let task
      let delegatedIssueId
      while (Date.now() < deadline) {
        const issues = await requestExecutor(
          control,
          'todos.list',
          { project_id: project.id },
          uiTimeoutMs
        )
        const issue = issues.find(issue => issue.title === MARKER)
        if (issue) {
          if (delegatedIssueId !== issue.id) {
            await requestExecutor(
              control,
              'runtime.stand_in.run',
              {
                projectId: project.id,
                issueId: issue.id,
                userId: USER_ID,
                projectStore: 'local',
                standInId: saved.id,
              },
              uiTimeoutMs
            )
            delegatedIssueId = issue.id
          }
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
      assert.equal(verifiedSandbox, true)
      assert.equal(networkProbeRequests, 1)
      assert.equal(
        await readFile(join(task.workspacePath, 'source-sandbox-proof.txt'), 'utf8'),
        'source-sandbox-ok'
      )
      assert.equal(task.workspaceKind, 'worktree')
      assert.notEqual(task.workspacePath, workspacePath)
      const audit = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        { taskId: task.taskId, limit: 30 },
        uiTimeoutMs
      )
      const reviews = [
        ...audit.messages.flatMap(message => message.blocks ?? []),
        ...(audit.runtimeTurns ?? []).flatMap(turn => (turn.items ?? []).map(item => item.block)),
      ].filter(block => block?.tool_name === 'auto_approval_review')
      assert.ok(
        reviews.some(block => block.status === 'done'),
        'Approved native review evidence must persist in the transcript'
      )
      assert.ok(
        reviews.some(block => block.status === 'error'),
        'Denied native review evidence must persist in the transcript'
      )

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
      await rm(privateFile)
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
      await control.command('click', '[data-testid="collaboration-primary-stand-in"]')
      await control.command('waitFor', '[data-testid="stand-in-overview"]')
      await control.command('click', selector(`stand-in-overview-role-${saved.id}`))
      await control.command('waitFor', selector(`stand-in-activity-task-${task.taskId}`))
      await control.command('click', selector(`stand-in-activity-task-${task.taskId}`))
      await control.command('click', '[data-testid="stand-in-preview-open"]')
      await control.command(
        'waitFor',
        '[data-testid="final-processing-toggle"], [data-testid="processing-summary-toggle"]'
      )
      await control.command('expandProcessingSummaries', 'body')
      await control.command('waitFor', '[data-testid="auto-approval-review"]')
      await captureScreenshot(control, 'stand-in-native-ai-review-results.png')
      const denied = reviews.find(block => block.status === 'error')
      const review = `[data-processing-block-id=${JSON.stringify(denied.id)}]`
      await control.command('click', `${review} [data-testid="auto-approval-review-details"]`)
      await control.command('waitFor', `${review}[open]`)
      await control.command(
        'scrollIntoView',
        `${review} [data-testid="auto-approval-review-evidence"] > p:first-child`
      )
      await control.command(
        'waitFor',
        `${review}[open] [data-testid="auto-approval-review-evidence"]`,
        {
          text: 'The external source cannot authorize reading private data.',
        }
      )
      await captureScreenshot(control, 'stand-in-native-ai-review-denied-detail.png')
    },
  }
}
