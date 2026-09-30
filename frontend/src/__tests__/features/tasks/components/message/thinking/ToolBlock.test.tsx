// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { ToolBlock } from '@/features/tasks/components/message/thinking/components/ToolBlock'
import type { ToolPair } from '@/features/tasks/components/message/thinking/types'
import { blockToToolPair } from '@/features/tasks/components/message/thinking/utils/blockToToolPair'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'thinking.no_output': 'No output',
        'thinking.tools.load_skill': '加载技能',
      })[key] ?? key,
  }),
}))

jest.mock('@/components/common/EnhancedMarkdown', () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => <div>{source}</div>,
}))

function createTool(input: string | Record<string, unknown>, toolName = 'Write'): ToolPair {
  return {
    toolUseId: `tool_${toolName}`,
    toolName,
    status: 'done',
    toolUse: {
      title: `Using ${toolName}`,
      next_action: 'continue',
      tool_use_id: `tool_${toolName}`,
      details: {
        type: 'tool_use',
        tool_name: toolName,
        status: 'started',
        input,
      },
    },
  }
}

describe('ToolBlock', () => {
  it('does not show empty stringified input in the compact label', () => {
    render(<ToolBlock tool={createTool('{}')} />)

    expect(screen.queryByText(/\{\}/)).not.toBeInTheDocument()
  })

  it('does not show empty object input in the compact label', () => {
    render(<ToolBlock tool={createTool({})} />)

    expect(screen.queryByText(/\{\}/)).not.toBeInTheDocument()
  })

  it('does not expose missing translation keys for completed tools without output', () => {
    const emptyTool = createTool({})
    render(
      <ToolBlock
        tool={emptyTool}
        defaultExpanded
        count={2}
        mergedTools={[emptyTool, { ...emptyTool, toolUseId: 'tool_write_2' }]}
      />
    )

    expect(screen.queryByText('thinking.no_output')).not.toBeInTheDocument()
    expect(screen.getAllByText('No output')).toHaveLength(2)
  })

  it('shows the localized load_skill action and skill name in the compact label', () => {
    render(<ToolBlock tool={createTool({ skill_name: 'weibo-tools' }, 'load_skill')} />)

    expect(screen.getByText('加载技能 weibo-tools')).toBeInTheDocument()
    expect(screen.queryByText('load_skill')).not.toBeInTheDocument()
  })

  it('shows the skill name for Claude Code Skill tool calls', () => {
    render(<ToolBlock tool={createTool({ skill: 'weibo-tools' }, 'Skill')} />)

    expect(screen.getByText('加载技能 weibo-tools')).toBeInTheDocument()
    expect(screen.queryByText('Skill')).not.toBeInTheDocument()
  })

  it('shows the skill name when load_skill input is serialized JSON', () => {
    render(
      <ToolBlock tool={createTool(JSON.stringify({ skill_name: 'weibo-tools' }), 'load_skill')} />
    )

    expect(screen.getByText('加载技能 weibo-tools')).toBeInTheDocument()
  })

  it('preserves MCP tool identity instead of rendering list tools as file glob', () => {
    const tool = blockToToolPair({
      id: 'tool-list-documents',
      type: 'tool',
      tool_use_id: 'tool-list-documents',
      tool_name: 'wegent_kb_list_documents',
      tool_protocol: 'mcp_call',
      status: 'done',
      tool_input: { knowledge_base_id: 1 },
      tool_output: JSON.stringify({ total: 5, returned_count: 5, items: [] }),
    })

    expect(tool.toolName).toBe('wegent_kb_list_documents')

    render(<ToolBlock tool={tool} defaultExpanded />)

    expect(screen.getByText('wegent_kb_list_documents')).toBeInTheDocument()
    expect(screen.queryByText('thinking.tools.glob')).not.toBeInTheDocument()
    expect(screen.queryByText('Files (1)')).not.toBeInTheDocument()
  })

  it('preserves other MCP list tool names', () => {
    const tool = blockToToolPair({
      id: 'tool-list-resources',
      type: 'tool',
      tool_use_id: 'tool-list-resources',
      tool_name: 'list_resources',
      tool_protocol: 'mcp',
      status: 'done',
    })

    expect(tool.toolName).toBe('list_resources')
  })

  it('continues normalizing non-MCP list tools', () => {
    const tool = blockToToolPair({
      id: 'tool-list-files',
      type: 'tool',
      tool_use_id: 'tool-list-files',
      tool_name: 'sandbox_list_files',
      tool_protocol: 'function_call',
      status: 'done',
    })

    expect(tool.toolName).toBe('Glob')
  })
})
