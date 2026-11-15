import { describe, expect, it } from 'vitest'
import { chatReducer } from './chatReducer'
import { collectMobileSubagents, mobileSubagentActive } from './mobileSubagents'

const rawAgent = {
  id: 'agent-block',
  type: 'subagent',
  agent_thread_id: 'child-thread',
  agent_type: 'Explorer',
  description: 'Inspect events',
  status: 'streaming',
  createdAt: 1,
}
const history = (blocks: Record<string, unknown>[]) =>
  chatReducer([], {
    type: 'replace',
    messages: [
      { id: 'parent-message', subtaskId: 'parent-turn', role: 'assistant', content: '', blocks },
    ],
  })

describe('Mobile subagent PC projection parity', () => {
  it('preserves native subagent identity, live child ownership, output updates and parent completion independence', () => {
    let state = history([
      rawAgent,
      {
        id: 'child-text',
        type: 'text',
        parent_tool_use_id: 'agent-block',
        content: 'Inspecting',
        status: 'streaming',
      },
    ])
    const apply = (name: string, data: Record<string, unknown>) => {
      state = chatReducer(state, {
        type: 'stream',
        event: { name, payload: { subtaskId: 'parent-turn', data } },
      })
    }
    expect(collectMobileSubagents(state)[0]).toMatchObject({
      agentThreadId: 'child-thread',
      agentType: 'Explorer',
      children: [{ id: 'child-text', content: 'Inspecting' }],
    })
    apply('response.completed', {})
    expect(collectMobileSubagents(state)[0]?.status).toBe('streaming')
    apply('response.block.updated', {
      blockId: 'agent-block',
      updates: { output: 'Result', summary: 'Reviewed', agentStatus: 'done', status: 'done' },
    })
    expect(collectMobileSubagents(state)[0]).toMatchObject({
      output: 'Result',
      summary: 'Reviewed',
      agentStatus: 'done',
      status: 'done',
    })
    expect(mobileSubagentActive(collectMobileSubagents(state)[0]!)).toBe(false)
  })

  it('uses the shared persisted spawn/wait projection instead of counting tool calls as separate agents', () => {
    const state = history([
      {
        id: 'spawn',
        type: 'tool',
        toolName: 'multi_agent_v1.spawn_agent',
        toolInput: { message: 'Say hello', agent_type: 'explorer' },
        toolOutput: JSON.stringify({ agent_id: 'agent-1' }),
        status: 'done',
      },
      {
        id: 'wait',
        type: 'tool',
        toolName: 'multi_agent_v1.wait_agent',
        toolInput: { targets: ['agent-1'] },
        toolOutput: JSON.stringify({ status: 'completed' }),
        status: 'done',
      },
    ])
    expect(collectMobileSubagents(state)).toEqual([
      expect.objectContaining({
        agentThreadId: 'agent-1',
        description: 'Say hello',
        status: 'done',
      }),
    ])
  })

  it('collects descendants and keeps the latest duplicate child identity without reordering it', () => {
    const first = history([
      { ...rawAgent, children: [{ ...rawAgent, id: 'nested', agent_thread_id: 'nested-thread' }] },
    ])
    const later = history([{ ...rawAgent, id: 'later-block', output: 'Latest', status: 'done' }])
    expect(collectMobileSubagents([...first, ...later])).toMatchObject([
      { id: 'later-block', agentThreadId: 'child-thread', output: 'Latest' },
      { id: 'nested', agentThreadId: 'nested-thread' },
    ])
  })

  it('preserves canonical file-change ownership when normalized native blocks are reused in child panels', () => {
    const source = {
      version: 1,
      status: 'active',
      artifact_id: 'artifact',
      device_id: 'owner',
      workspace_path: '/child-tree',
      file_count: 1,
      additions: 1,
      deletions: 0,
      files: [{ path: 'a.ts', change_type: 'created', additions: 1, deletions: 0, binary: false }],
      diff: 'diff --git a/a.ts b/a.ts\n+new',
    }
    const initial = history([
      { id: 'diff', type: 'file_changes', file_changes: source, status: 'done' },
    ])
    const repeated = chatReducer([], {
      type: 'replace',
      messages: initial.map(message => ({
        ...message,
        blocks: message.blocks?.map(block => ({ ...block })),
      })),
    })
    expect(repeated[0]?.fileChanges?.source).toMatchObject(source)
  })
})
