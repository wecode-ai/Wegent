import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_DEVICE_ID,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_PUBLIC_MODEL_OPTIONS,
  fetchJson,
} from './shared.mjs'
import {
  assistantMessage,
  selectedToolCall,
  selectTool,
  requestContainsToolOutput,
  toolOutputText,
} from './response-protocol.mjs'

const PROMPT = 'WEWORK_CLOUD_BLOCKING_QUESTION_FILES'
const CONTENT = 'CLOUD_BLOCKING_QUESTION_REAL_FILE_BYTES'
const FILE = 'cloud-question-brief.txt'
const DONE = 'CLOUD_BLOCKING_QUESTION_FILES_COMPLETE'
const CARD = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`

// Reuse the Cloud recovery checkpoint and real Backend, storage and Executor.
export function createCloudQuestionAttachments({ modelResponseTimeoutMs }) {
  let verified = false
  return {
    respond(body) {
      const strings = value =>
        typeof value === 'string'
          ? value
          : Object.values(value ?? {})
              .map(strings)
              .join('\n')
      const text = strings(body.input ?? body.messages)
      if (!text.includes(PROMPT)) return undefined
      if (!requestContainsToolOutput(body, 'cloud-question-files'))
        return selectedToolCall(
          'cloud-question-files',
          selectTool(body, 'request_user_input', {
            questions: [
              {
                id: 'brief',
                header: 'Brief',
                question: PROMPT,
                options: [
                  { label: 'Review', description: 'Review the attached brief' },
                  { label: 'Revise', description: 'Revise the attached brief' },
                ],
              },
            ],
          })
        )
      if (!requestContainsToolOutput(body, 'cloud-question-read')) {
        const answer = JSON.parse(toolOutputText(body, 'cloud-question-files'))
        const context = answer.answers.brief.answers.join('\n')
        const path = context.match(/Local File Path: ([^\n]+)/)?.[1]
        assert.ok(path, 'The cloud blocking answer must contain a prepared file path')
        const quoted = `'${path.replaceAll("'", "'\\''")}'`
        return selectedToolCall(
          'cloud-question-read',
          selectTool(body, 'exec_command', {
            cmd: `node -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" ${quoted}`,
            max_output_tokens: 200,
          })
        )
      }
      assert.ok(text.includes(CONTENT), 'The real cloud Executor must read the uploaded bytes')
      verified = true
      return [assistantMessage(DONE)]
    },
    async verify(cloud, control) {
      const request = (path, body) =>
        fetchJson(`${cloud.backendUrl}${path}`, {
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'Content-Type': 'application/json',
          },
        })
      const teams = await request('/api/teams?page=1&limit=100')
      assert.ok(teams.items?.[0]?.id)
      const workspacePath = join(cloud.runtimeWorkspaceRoot, `question-files-${process.pid}`)
      await mkdir(workspacePath, { recursive: true })
      const created = await request('/api/runtime-work/create', {
        deviceId: CLOUD_DEVICE_ID,
        workspacePath,
        teamId: teams.items[0].id,
        runtime: 'codex',
        message: PROMPT,
        title: 'Cloud blocking question attachments',
        modelId: CLOUD_PUBLIC_MODEL_NAME,
        modelType: 'public',
        modelOptions: { ...CLOUD_PUBLIC_MODEL_OPTIONS, collaboration_mode: 'plan' },
        modelSelection: {
          modelName: CLOUD_PUBLIC_MODEL_NAME,
          modelType: 'public',
          options: { ...CLOUD_PUBLIC_MODEL_OPTIONS, collaboration_mode: 'plan' },
        },
      })
      assert.equal(created.accepted, true, created.error)
      const query = new URLSearchParams({ deviceId: CLOUD_DEVICE_ID, taskId: created.taskId })
      await control.command('navigate', 'body', { value: `/runtime-tasks?${query}` })
      await control.command('waitFor', CARD, { text: PROMPT, timeoutMs: modelResponseTimeoutMs })
      const input = `${CARD} [data-testid="request-user-input-custom-brief"]`
      await control.command('fill', input, { value: 'Review the brief\nPreserve both lines' })
      await control.command('pasteFile', input, {
        filename: FILE,
        mimeType: 'text/plain',
        value: Buffer.from(CONTENT).toString('base64'),
      })
      await control.command('waitFor', `${CARD} [data-testid="attachment-badge"]`, { text: FILE })
      await control.command(
        'clickWhenEnabled',
        `${CARD} [data-testid="request-user-input-submit-button"]`
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: DONE,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      assert.ok(verified)
      const task = await cloud.waitForRuntimeTask({
        deviceId: CLOUD_DEVICE_ID,
        taskId: created.taskId,
        workspacePath,
      })
      assert.equal(task.status, 'done')
    },
  }
}
