import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PhaseRegressionStep } from './codex-phase-regression'

export const sharedCapability = {
  skill: 'interactive',
  heading: '# Ask User',
  result: 'result: 84',
}

export async function sharedBotGrants(skillRef: object) {
  const program = await readFile(
    resolve(__dirname, '../../../wework/e2e/utils/tool-details-mcp-server.mjs'),
    'utf8'
  )
  return {
    inherit_base_capabilities: false,
    skills: [sharedCapability.skill],
    skill_refs: { [sharedCapability.skill]: skillRef },
    mcp_servers: {
      capability: {
        type: 'stdio',
        command: 'node',
        args: ['--input-type=module', '-e', program, 'probe', 'node_repl', 'receipts'],
      },
    },
  }
}

export function sharedCodexProbe(): PhaseRegressionStep[] {
  return [
    {
      toolCalls: [
        {
          toolName: 'exec_command',
          arguments: {
            cmd: 'for dir in "${CODEX_HOME:-.codex}/skills" .codex/skills; do if test -f "$dir/interactive/SKILL.md"; then grep -m 1 "^# " "$dir/interactive/SKILL.md"; exit $?; fi; done; exit 1',
          },
        },
      ],
    },
    { toolCalls: [{ toolName: 'js', arguments: { code: '7 * 12' } }] },
  ]
}

// Restrict attribution to real tool output blocks, excluding prompts and tool-call arguments.
export function botMcpReceipt(bodies: unknown[], marker: string): string {
  const receipts = new Set<string>()
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach(visit)
    const block = value as { type?: string; content?: unknown; output?: unknown }
    if (
      ['tool_result', 'function_call_output', 'custom_tool_call_output'].includes(block.type ?? '')
    ) {
      const output = JSON.stringify(block.output ?? block.content ?? '')
      if (output.includes(marker)) {
        for (const match of output.matchAll(
          /MCP_RECEIPT:([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/g
        ))
          receipts.add(match[1])
      }
      return
    }
    Object.values(block).forEach(visit)
  }
  bodies.forEach(visit)
  if (receipts.size !== 1)
    throw new Error(
      'Expected one distinct MCP receipt for ' + marker + ', received ' + receipts.size
    )
  return [...receipts][0]
}
