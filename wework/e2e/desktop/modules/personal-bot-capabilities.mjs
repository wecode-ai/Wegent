import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createZipFixture } from './zip-fixtures.mjs'
import { startEmptyCommandHttpMcp } from './empty-command-http-mcp.mjs'
import {
  createSse,
  mcpToolRequestEvents,
  responseCompleted,
  responseCreated,
  selectTool,
  selectedToolCall,
  toolOutputText,
} from './response-protocol.mjs'

export async function installPersonalBotCapability(cloud, resultDir, slot, probe) {
  const name = 'personal-bot-' + slot
  const marker = randomUUID()
  const archive = join(resultDir, name + '.zip')
  await createZipFixture(archive, {
    [name + '/SKILL.md']:
      `---\nname: ${name}\ndescription: Review the ${name} delivery\n---\n${marker}\n`,
  })
  const form = new FormData()
  form.set('file', new Blob([await readFile(archive)]), name + '.zip')
  form.set('name', name)
  form.set('namespace', 'default')
  const uploaded = await fetch(cloud.backendUrl + '/api/v1/kinds/skills/upload', {
    method: 'POST',
    body: form,
    headers: { Authorization: 'Bearer ' + cloud.authToken },
  })
  assert.ok(uploaded.ok, await uploaded.clone().text())
  const skill = await uploaded.json()
  const token = 'synthetic-mcp-secret-' + slot
  return {
    name,
    marker,
    token,
    grants: {
      skills: [name],
      skill_refs: {
        [name]: {
          skill_id: Number(skill.metadata.labels.id),
          namespace: 'default',
          is_public: false,
        },
      },
      mcp_servers: {
        personalprobe: { type: 'http', url: probe.config.url, headers: { 'X-Test-Token': token } },
      },
    },
  }
}

export function startPersonalBotProbe(resultDir) {
  return startEmptyCommandHttpMcp(join(resultDir, 'personal-mcp-probe.json'), {
    recordReceipts: true,
  })
}

export function checkPersonalBotTurn({ cell, reviewer, body, headers, response, writeToolCall }) {
  const botId = reviewer ? 2 : 1
  const capability = cell.capabilities[reviewer && cell.mode === 'pipeline' ? 1 : 0]
  const key = cell.id + '-bot-' + botId
  if (cell.observed[botId]) return false
  const send = events => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(createSse([responseCreated(key), ...events, responseCompleted(key)]))
  }
  const skillCall = key + '-read'
  const skillOutput = toolOutputText(body, skillCall)
  if (!skillOutput) {
    const input = JSON.stringify([body.instructions, body.input])
    assert.ok(input.includes(capability.name), 'Selected Bot skill must be discoverable')
    const other = cell.capabilities.find(item => item !== capability)
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    let file
    let sibling
    if (cell.runtime === 'claude_code') {
      file = '"$CLAUDE_CONFIG_DIR/skills/' + capability.name + '/SKILL.md"'
      sibling = '"$CLAUDE_CONFIG_DIR/skills/' + other.name + '/SKILL.md"'
    } else {
      const path = input.match(
        new RegExp('(/[^"\\\\<>\\s]*/' + capability.name + '/SKILL\\.md)')
      )?.[1]
      assert.ok(path, 'Codex did not receive the native skill path for ' + capability.name)
      file = quote(path)
      sibling = quote(join(dirname(dirname(path)), other.name, 'SKILL.md'))
    }
    const command = 'test ! -e ' + sibling + ' && cat ' + file
    if (cell.runtime === 'claude_code')
      writeToolCall(response, skillCall, skillCall, 'Bash', {
        command,
        description: 'Read the assigned Bot skill',
      })
    else send(selectedToolCall(skillCall, selectTool(body, 'exec_command', { cmd: command })))
    return true
  }
  assert.ok(skillOutput.includes(capability.marker), 'Bot read an unexpected skill body')
  const callId = key + '-probe'
  const output = toolOutputText(body, callId)
  if (!output) {
    const tool = 'mcp__personalprobe__probe_environment'
    const search = key + '-search'
    if (cell.runtime === 'claude_code') {
      if (!body.tools?.some(entry => entry.name === tool) && !toolOutputText(body, search)) {
        writeToolCall(response, search, search, 'ToolSearch', { query: 'select:' + tool })
      } else writeToolCall(response, callId, callId, tool, {})
    } else
      send(
        mcpToolRequestEvents(body, {
          toolName: 'probe_environment',
          directToolName: tool,
          argumentsValue: {},
          searchCallId: search,
          toolCallId: callId,
        }).events
      )
    return true
  }
  assert.ok(output.includes('MCP_CONTEXT:' + capability.token), 'MCP call used another Bot grant')
  const receipt = output.match(/MCP_RECEIPT:([0-9a-f-]{36})/)?.[1]
  assert.ok(receipt, 'MCP call must return its server-generated receipt')
  assert.ok(
    cell.probe.receipts.some(row => row.token === capability.token && row.receipt === receipt)
  )
  cell.observed[botId] = {
    threadId: headers?.['thread-id'],
    parentThreadId: headers?.['x-codex-parent-thread-id'],
    sessionId: headers?.['session-id'],
    nativeSubagent: headers?.['x-openai-subagent'],
    receipt,
    botId,
    skill: capability.name,
    skillCall,
    skillMarker: capability.marker,
    mcpCall: callId,
    mcpContext: capability.token,
  }
  return false
}
