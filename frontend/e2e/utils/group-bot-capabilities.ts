// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect } from '@playwright/test'
import JSZip from 'jszip'
import type { ApiClient } from './api-client'
import {
  modelRequestText,
  modelToolNames,
  type ToolScenarioStep,
} from './provider-native-test-support'

const server = readFileSync(
  resolve(__dirname, '../../../wework/e2e/utils/tool-details-mcp-server.mjs'),
  'utf8'
)

export async function createGroupBotCapability(
  api: ApiClient,
  role: 'leader' | 'worker',
  suffix: string,
  skillCleanup: number[]
) {
  const name = `group-${role}-${suffix}`
  const marker = `skill-body-${randomUUID()}`
  const zip = new JSZip()
  zip.file(
    `${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: Inspect the assigned group delivery\n---\n${marker}\n`
  )
  const upload = await api.uploadSkill({
    name,
    namespace: 'default',
    file: await zip.generateAsync({ type: 'nodebuffer' }),
  })
  expect(upload.status).toBe(201)
  const skillId = Number(
    (upload.data as { metadata: { labels: { id: string } } }).metadata.labels.id
  )
  expect(skillId).toBeGreaterThan(0)
  skillCleanup.push(skillId)
  expect((await api.delete(`/api/v1/kinds/skills/${skillId}/bindings/me`)).status).toBe(204)
  const leader = role === 'leader'
  const tool = leader ? 'get_issue_details' : 'js'
  // Use distinct server IDs even when the native Shell prefixes tool names.
  const serverId = leader ? 'groupissue' : 'groupcalc'
  const serverFixture = leader ? 'github__issues' : 'node_repl'
  const result = leader ? 'Tool detail verification' : 'result: 84'
  const refs = { [name]: { skill_id: skillId, namespace: 'default', is_public: false } }
  return {
    name,
    marker,
    tool,
    serverId,
    result,
    config: {
      skills: [name],
      skill_refs: refs,
      preload_skills: [name],
      preload_skill_refs: refs,
      mcp_servers: {
        [serverId]: {
          type: 'stdio',
          command: 'node',
          args: [
            '--input-type=module',
            '-e',
            server,
            '--',
            'group-probe',
            serverFixture,
            'receipts',
          ],
        },
      },
    },
  }
}

type Grant = Awaited<ReturnType<typeof createGroupBotCapability>>

export function groupBotProbe(shell: string, grant: Grant, other: Grant): ToolScenarioStep[] {
  const claude = shell === 'ClaudeCode'
  const roots = claude
    ? '"${SKILLS_DIR:-${CLAUDE_CONFIG_DIR:-.claude}/skills}"'
    : '"${CODEX_HOME:-.codex}/skills" .codex/skills'
  const cmd = [
    `for root in ${roots}; do`,
    `  test ! -e "$root/${other.name}/SKILL.md" || exit 1`,
    `  if test -f "$root/${grant.name}/SKILL.md"; then skill="$root/${grant.name}/SKILL.md"; fi`,
    'done',
    'cat "$skill"',
  ].join('\n')
  return [
    {
      toolCalls: [
        {
          toolName: claude ? 'Bash' : 'exec_command',
          arguments: claude ? { command: cmd } : { cmd },
        },
      ],
    },
    ...(claude
      ? [
          {
            toolCalls: [
              {
                toolName: 'ToolSearch',
                arguments: { query: `select:mcp__${other.serverId}__${other.tool}` },
              },
              {
                toolName: 'ToolSearch',
                arguments: { query: `select:mcp__${grant.serverId}__${grant.tool}` },
              },
            ],
          },
        ]
      : []),
    {
      toolCalls: [
        {
          toolName: claude ? `mcp__${grant.serverId}__${grant.tool}` : grant.tool,
          arguments:
            grant.tool === 'js'
              ? { code: '6 * 14' }
              : { owner: 'group', repo: 'release', issue_number: 7 },
          inspectToolNames: [`${other.serverId}__${other.tool}`],
        },
      ],
    },
  ]
}

export function verifyGroupBotProbe(bodies: Record<string, unknown>[], grant: Grant, other: Grant) {
  const records = bodies.flatMap(body =>
    ((body.messages ?? body.input ?? []) as Array<Record<string, unknown>>).flatMap(message =>
      Array.isArray(message.content) ? [...message.content, message] : [message]
    )
  )
  const fullName = `mcp__${grant.serverId}__${grant.tool}`
  const calls = new Set(
    records
      .filter(block => {
        if (!['tool_use', 'function_call', 'custom_tool_call'].includes(block.type)) return false
        if (block.name === fullName || block.name === grant.tool) return true
        return (
          ['functions.exec', 'functions__exec', 'exec'].includes(block.name) &&
          JSON.stringify(block.input ?? block.arguments).includes(grant.tool)
        )
      })
      .map(block => block.call_id ?? block.id)
  )
  const outputs = records.filter(block =>
    ['function_call_output', 'custom_tool_call_output', 'tool_result'].includes(block.type)
  )
  if (bodies.some(body => Array.isArray(body.messages))) {
    const deniedName = `mcp__${other.serverId}__${other.tool}`
    const searches = records.filter(
      block =>
        block.type === 'tool_use' &&
        block.name === 'ToolSearch' &&
        block.input?.query === 'select:' + deniedName
    )
    expect(searches.length).toBeGreaterThan(0)
    const searchIds = new Set(searches.map(block => block.id))
    const searchResults = outputs.filter(block => searchIds.has(block.tool_use_id))
    expect(searchResults.length).toBeGreaterThan(0)
    for (const block of searchResults) {
      expect(block.is_error).not.toBe(true)
      expect(block.content).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool_reference', tool_name: deniedName }),
        ])
      )
    }
  }
  const transcript = modelRequestText(outputs)
  expect(transcript).toContain(grant.marker)
  const receipts = new Set(
    outputs
      .filter(block => calls.has(block.call_id ?? block.tool_use_id))
      .flatMap(block => {
        const text = modelRequestText([block.output ?? block.content])
        return text.includes(grant.result) ? (text.match(/MCP_RECEIPT:[0-9a-f-]{36}/gi) ?? []) : []
      })
  )
  expect(receipts.size, 'Exactly one direct MCP result per Bot').toBe(1)
  expect(transcript).toContain(grant.result)
  expect(transcript).not.toContain(other.marker)
  const names = modelToolNames(bodies)
  expect(names.some(name => name.includes(other.serverId))).toBe(false)
  return {
    receipt: [...receipts][0],
    skill: grant.name,
    skillMarker: grant.marker,
    tool: `${grant.serverId}__${grant.tool}`,
    result: grant.result,
    excludedServer: other.serverId,
  }
}

export function verifyLegacyBotProbe(
  bodies: Record<string, unknown>[],
  grant: Grant,
  other: Grant
) {
  expect(bodies.length).toBeGreaterThan(1)
  const first = modelRequestText([bodies[0]])
  expect(first).toContain(grant.marker)
  expect(first).not.toContain(other.marker)
  const tools = modelToolNames(bodies)
  expect(tools.some(name => name.includes(grant.serverId))).toBe(true)
  expect(tools.some(name => name.includes(other.serverId))).toBe(false)
  type Message = {
    role: string
    content: unknown
    tool_call_id?: string
    tool_calls?: { id: string; function: { name: string } }[]
  }
  const messages = bodies.flatMap(body => body.messages as Message[])
  const callIds = new Set(
    messages.flatMap(message =>
      (message.tool_calls ?? [])
        .filter(
          call =>
            call.function.name.includes(grant.serverId) && call.function.name.endsWith(grant.tool)
        )
        .map(call => call.id)
    )
  )
  const outputs = messages
    .filter(
      message =>
        message.role === 'tool' && message.tool_call_id && callIds.has(message.tool_call_id)
    )
    .map(message => modelRequestText([message.content]))
  const receipts = new Set(
    outputs
      .filter(text => text.includes(grant.result))
      .flatMap(text => text.match(/MCP_RECEIPT:[0-9a-f-]{36}/gi) ?? [])
  )
  expect(receipts.size).toBe(1)
  return {
    skill: grant.name,
    skillMarker: grant.marker,
    tool: grant.tool,
    receipt: [...receipts][0],
  }
}

export async function deleteBotCapabilityFixtures(
  api: ApiClient,
  resources: string[],
  skills: number[]
) {
  for (const path of resources) {
    const resource = '/api/v1/namespaces/default/' + path
    if (path.startsWith('bots/')) {
      const bot = await api.get<{ spec: { ghostRef: { name: string; namespace?: string } } }>(
        resource
      )
      expect(bot.status, JSON.stringify(bot.data)).toBe(200)
      const { name, namespace = 'default' } = bot.data!.spec.ghostRef
      const removed = await api.delete(resource)
      expect(removed.status, JSON.stringify(removed.data)).toBe(200)
      const ghost = await api.delete(`/api/v1/namespaces/${namespace}/ghosts/${name}`)
      expect(ghost.status, JSON.stringify(ghost.data)).toBe(200)
    } else {
      const removed = await api.delete(resource)
      expect(removed.status, JSON.stringify(removed.data)).toBe(200)
    }
  }
  for (const id of skills) {
    const removed = await api.delete(`/api/v1/kinds/skills/${id}`)
    expect(removed.status, JSON.stringify(removed.data)).toBe(204)
  }
}
