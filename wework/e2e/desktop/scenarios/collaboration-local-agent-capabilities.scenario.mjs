import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT_NAME = `本地智能体能力验收-${process.pid}`
const AGENT_NAME = `本地能力智能体-${process.pid}`
const GROUP_NAME = `本地能力协作小组-${process.pid}`
const ISSUE_NAME = `本地智能体执行验收-${process.pid}`
const RUN_MARKER = 'LOCAL_AGENT_CAPABILITY_E2E_RUN'
const COMPLETION_MARKER = 'LOCAL_AGENT_CAPABILITY_E2E_COMPLETED'
const SKILL_NAME = `local-agent-skill-${process.pid}`
const SKILL_ID = 91001
const SKILL_MARKER = 'LOCAL_AGENT_REAL_SKILL'
const PLUGIN_NAME = 'smart-app-builder'
const PLUGIN_MARKETPLACE = 'wework-personal'
const PLUGIN_ID = `${PLUGIN_NAME}@${PLUGIN_MARKETPLACE}`
const PLUGIN_VERSION = '0.1.0'
const PLUGIN_SKILL_NAME = 'create-smart-app'
const PLUGIN_SKILL_MARKER = 'inspect → contract → doctor → verify → preview → pack'
const MODEL_NAME = 'wework-custom-desktop-e2e-responses'

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function prepareCapabilities(executorHome) {
  const codexHome = join(executorHome, 'codex')
  const skillRoot = join(codexHome, 'skills', SKILL_NAME)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    [
      '---',
      `name: ${SKILL_NAME}`,
      'description: Local Agent end-to-end Skill.',
      '---',
      '',
      `Preserve ${SKILL_MARKER} in the execution context.`,
      '',
    ].join('\n'),
    'utf8'
  )
}

async function findStagedSkillFile(root, skillName) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === skillName) {
        const skillFile = join(path, 'SKILL.md')
        const content = await readFile(skillFile, 'utf8').catch(() => null)
        if (content !== null) return { content, skillFile }
      }
      const nested = await findStagedSkillFile(path, skillName)
      if (nested) return nested
    }
  }
  return null
}

export async function createDesktopScenario({
  captureScreenshot,
  executorHome,
  modelResponseTimeoutMs,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  await prepareCapabilities(executorHome)
  const resultRoot = dirname(executorHome)
  let active = false
  let verifiedRequest = null

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/models/unified') {
        json(response, 200, {
          data: [
            {
              name: MODEL_NAME,
              type: 'public',
              displayName: 'Desktop E2E Public',
              namespace: 'default',
              isActive: true,
            },
          ],
        })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/kinds/skills/unified') {
        json(response, 200, [
          {
            id: SKILL_ID,
            name: SKILL_NAME,
            namespace: 'codex',
            description: `Local Agent Skill containing ${SKILL_MARKER}.`,
            displayName: 'Local Agent E2E Skill',
            bindShells: ['Codex'],
            visible: true,
            is_active: true,
            is_public: false,
            user_id: 1,
          },
        ])
        return true
      }
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      const serialized = JSON.stringify(body)
      if (!serialized.includes(RUN_MARKER)) return false
      assert.ok(serialized.includes(SKILL_NAME), 'The local Agent did not receive its Skill')
      const stagedSkill = await findStagedSkillFile(join(resultRoot, 'home'), SKILL_NAME)
      assert.ok(stagedSkill, 'The selected local Skill was not staged into the task workspace')
      assert.ok(
        stagedSkill.content.includes(SKILL_MARKER),
        'The staged local Skill did not contain the selected Skill content'
      )
      assert.ok(serialized.includes(PLUGIN_NAME), 'The local Agent did not receive its plugin')
      assert.ok(
        serialized.includes(`${PLUGIN_NAME}:${PLUGIN_SKILL_NAME}`),
        'The local Agent plugin entry Skill was not attached to the model request'
      )
      const pluginSkillFile = join(
        executorHome,
        'codex',
        'plugins',
        'cache',
        PLUGIN_MARKETPLACE,
        PLUGIN_NAME,
        PLUGIN_VERSION,
        'skills',
        PLUGIN_SKILL_NAME,
        'SKILL.md'
      )
      const pluginSkillContent = await readFile(pluginSkillFile, 'utf8')
      assert.ok(
        pluginSkillContent.includes(PLUGIN_SKILL_MARKER),
        'The local Agent plugin entry Skill was not installed with the bundled plugin content'
      )
      verifiedRequest = body
      const responseId = `local-agent-capability-${Date.now()}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(COMPLETION_MARKER),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify(control) {
      active = true
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, ACTIVE_WORKBENCH_SELECTOR, PROJECT_NAME)
      await captureScreenshot(
        control,
        'collaboration-local-agent-01-project-created.png',
        ACTIVE_WORKBENCH_SELECTOR
      )

      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-participants"]')
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-agents"]')
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-participants-tab-agents"][aria-selected="true"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('clickWhenEnabled', scoped('[data-testid="project-agent-add"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
        value: AGENT_NAME,
      })
      await control.command('select', '[data-testid="cloud-project-chat-agent-model"]', {
        value: MODEL_NAME,
      })
      await control.command(
        'click',
        '[data-testid="cloud-project-chat-agent-editor-advanced-toggle"]'
      )
      await control.command(
        'click',
        '[data-testid="cloud-project-chat-agent-capability-mode-manual"]'
      )
      await control.command('click', '[data-testid="cloud-project-chat-agent-skills-add"]')
      await control.command('click', `[data-testid="cloud-project-chat-agent-skill-${SKILL_ID}"]`)
      await control.command('click', '[data-testid="cloud-project-chat-agent-plugins-add"]')
      await control.command('click', `[data-testid="cloud-project-chat-agent-plugin-${PLUGIN_ID}"]`)
      await control.command('fill', '[data-testid="cloud-project-chat-agent-system-prompt"]', {
        value: [
          RUN_MARKER,
          `[$${PLUGIN_NAME}](plugin://${PLUGIN_ID})`,
          'Use the configured Skill and plugin before completing the Issue.',
        ].join(' '),
      })
      await captureScreenshot(
        control,
        'collaboration-local-agent-02-capabilities-selected.png',
        '[data-testid="cloud-project-chat-agent-editor"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid^="project-agent-row-"]'), {
        text: AGENT_NAME,
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-groups"]')
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-participants-tab-groups"][aria-selected="true"]'),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
      await control.command('waitFor', scoped('[data-testid="collaboration-group-form"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
        value: GROUP_NAME,
      })
      await control.command(
        'click',
        scoped('[data-testid="collaboration-group-create-add-members"]')
      )
      const agentMemberTestId = await waitForTestIdByText(
        control,
        ACTIVE_WORKBENCH_SELECTOR,
        'collaboration-group-create-member-agent-',
        AGENT_NAME,
        uiTimeoutMs
      )
      await control.command('click', `[data-testid="${agentMemberTestId}"]`)
      await control.command('waitFor', scoped('.collaboration-group-selected-people'), {
        text: AGENT_NAME,
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="collaboration-group-create"]'),
        { timeoutMs: uiTimeoutMs }
      )
      const groupDetailTestId = await waitForTestIdByText(
        control,
        ACTIVE_WORKBENCH_SELECTOR,
        'collaboration-group-detail-local-group-',
        GROUP_NAME,
        uiTimeoutMs
      )
      const groupId = groupDetailTestId.slice('collaboration-group-detail-'.length)
      await captureScreenshot(
        control,
        'collaboration-local-agent-03-group-created.png',
        ACTIVE_WORKBENCH_SELECTOR
      )

      await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
      await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
      await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
        value: `${ISSUE_NAME} ${RUN_MARKER}`,
      })
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="cloud-todo-create-confirm"]'),
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
      await control.command(
        'click',
        `[data-testid="cloud-todo-detail-assignee-option-group:${groupId}"]`
      )
      await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(
        control,
        'collaboration-local-agent-04-execution-started.png',
        ACTIVE_WORKBENCH_SELECTOR
      )
      await control.command('waitFor', scoped('[data-testid^="task-activity-run-event-"]'), {
        text: '已完成',
        timeoutMs: modelResponseTimeoutMs,
      })
      const executorLog = await readFile(join(resultRoot, 'executor.log'), 'utf8')
      assert.ok(
        executorLog.includes(COMPLETION_MARKER),
        'The local Agent completion was not emitted by the runtime'
      )
      assert.ok(verifiedRequest, 'The local Agent never reached the real model request')
      await captureScreenshot(
        control,
        'collaboration-local-agent-05-capabilities-verified.png',
        ACTIVE_WORKBENCH_SELECTOR
      )
    },

    diagnostics() {
      return {
        active,
        pluginId: PLUGIN_ID,
        requestVerified: Boolean(verifiedRequest),
        skillName: SKILL_NAME,
      }
    },
  }
}
