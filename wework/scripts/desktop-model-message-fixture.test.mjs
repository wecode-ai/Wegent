// @vitest-environment node
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import {
  MODEL_API_KEY,
  DROPPED_PATH_COMPLETION_TEXT,
  DROPPED_PATH_FILE_NAME,
  DROPPED_PATH_FOLDER_NAME,
  CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT,
  CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT,
  PLUGIN_CREATOR_PROMPT,
  PLUGIN_CREATOR_COMPLETION_TEXT,
  PLUGIN_REFINEMENT_PROMPT,
  PLUGIN_REFINEMENT_COMPLETION_TEXT,
} from '../e2e/desktop/modules/shared.mjs'

const readyWorkspace = '[WEGENT_PLUGIN_RESULT]{"status":"ready"}'

for (const [name, prompt, completion, scenario] of [
  ['workspace result', readyWorkspace, readyWorkspace],
  [
    'recovery',
    CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT,
    CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT,
    'connector_auth_unmatched_resume',
  ],
  ['creator', PLUGIN_CREATOR_PROMPT, PLUGIN_CREATOR_COMPLETION_TEXT],
  ['refinement', PLUGIN_REFINEMENT_PROMPT, PLUGIN_REFINEMENT_COMPLETION_TEXT],
  [
    'dropped paths',
    `/isolated-model-message-fixture/${DROPPED_PATH_FOLDER_NAME} ${DROPPED_PATH_FILE_NAME}`,
    DROPPED_PATH_COMPLETION_TEXT,
    'dropped_workspace_paths',
  ],
]) {
  for (const protocol of ['responses', 'chat', 'anthropic']) {
    test(`${name} replies retain the selected ${protocol} wire protocol`, async () => {
      const server = new DesktopE2EServer('/isolated-model-message-fixture')
      if (scenario) server.scenario = scenario
      const message = { role: 'user', content: prompt }
      const body = protocol === 'responses' ? { input: [message] } : { messages: [message] }
      const request = Readable.from([JSON.stringify(body)])
      request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
      let output = ''
      await server.handleModelResponse(
        request,
        {
          writeHead(status, headers) {
            assert.equal(status, 200)
            assert.match(headers['Content-Type'], /text\/event-stream/)
          },
          end(value) {
            output = value
          },
        },
        protocol
      )
      const data = output
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))
      const events = data.filter(line => line !== '[DONE]').map(line => JSON.parse(line))
      if (protocol === 'responses') {
        assert.equal(events.at(-1).type, 'response.completed')
        const message = events.find(event => event.type === 'response.output_item.done').item
        assert.equal(message.content[0].text, completion)
      } else if (protocol === 'chat') {
        assert.equal(data.at(-1), '[DONE]')
        assert.equal(events.at(-1).choices[0].finish_reason, 'stop')
        assert.equal(events[0].choices[0].delta.content, completion)
      } else {
        assert.equal(events[0].type, 'message_start')
        assert.equal(events.at(-1).type, 'message_stop')
        assert.equal(
          events.find(event => event.type === 'content_block_delta').delta.text,
          completion
        )
        assert.equal(
          events.find(event => event.type === 'message_delta').delta.stop_reason,
          'end_turn'
        )
      }
    })
  }
}

for (const [scenario, prompt, completion] of [
  [
    'collaboration-worktree-policy',
    'COLLABORATION_WORKTREE_POLICY',
    'COLLABORATION_WORKTREE_POLICY_DONE',
  ],
  ['collaboration-issue-task-discovery', 'Issue task discovery', 'ISSUE_APP_RECORD_COMPLETE'],
  [
    'collaboration-issue-task-discovery',
    'Personal home start work Issue',
    'Personal home task complete',
  ],
]) {
  for (const [path, protocol] of [
    ['/responses', 'responses'],
    ['/v1/responses', 'responses'],
    ['/backend-api/codex/responses', 'responses'],
    ['/chat/completions', 'chat'],
    ['/v1/chat/completions', 'chat'],
    ['/messages', 'anthropic'],
    ['/v1/messages', 'anthropic'],
  ]) {
    test(`${scenario}: ${prompt} uses shared ${protocol} routing for ${path}`, async () => {
      const { createDesktopScenario } = await import(
        `../e2e/desktop/scenarios/${scenario}.scenario.mjs`
      )
      const server = new DesktopE2EServer('/isolated-model-message-fixture')
      server.url = 'http://127.0.0.1:1234'
      server.setDesktopScenario(createDesktopScenario({}))
      server.handleModelResponse = async () => {
        assert.fail('Custom requests must not enter the initial task fixture')
      }
      const message = { role: 'user', content: prompt }
      const request = Readable.from([
        JSON.stringify({
          model: 'synthetic-selected-model',
          ...(protocol === 'responses' ? { input: [message] } : { messages: [message] }),
        }),
      ])
      Object.assign(request, {
        method: 'POST',
        url: path,
        headers: { authorization: `Bearer ${MODEL_API_KEY}` },
      })
      let output
      await server.handle(request, {
        setHeader() {},
        once() {},
        writeHead(status) {
          assert.equal(status, 200)
        },
        end(value) {
          output = value
        },
      })
      assert.ok(output.includes(completion))
      assert.ok(
        output.includes(
          protocol === 'responses'
            ? 'response.completed'
            : protocol === 'chat'
              ? 'data: [DONE]'
              : 'message_stop'
        )
      )
      assert.equal(server.modelRequests.length, 1)
      assert.equal(server.modelRequests[0].body.model, 'synthetic-selected-model')
      assert.equal(Object.hasOwn(server.modelRequests[0], 'authorization'), false)
    })
  }
}
