import type { SubagentBlock } from '@/types/workbench'

type Translate = (key: string, options?: Record<string, unknown>) => string

export function getSubagentName(block: SubagentBlock, t: Translate): string {
  return (
    block.title ||
    block.description?.trim() ||
    block.agentType ||
    (block.agentId ? shortAgentId(block.agentId) : t('subagent.agent'))
  )
}

export function getSubagentPreview(block: SubagentBlock, t: Translate): string {
  if (block.output?.trim()) return block.output.trim()
  if (block.summary?.trim()) return block.summary.trim()
  const lastText = [...(block.children ?? [])]
    .reverse()
    .find(child => child.type === 'text' && child.content.trim())
  if (lastText?.type === 'text') return lastText.content.trim()
  if (block.description?.trim()) return block.description.trim()
  return block.status === 'done' ? t('subagent.no_output') : t('subagent.working')
}

export function getSubagentStatus(block: SubagentBlock, t: Translate): string {
  if (block.agentStatus === 'interrupted') return t('subagent.status_interrupted')
  if (block.status === 'error') return t('subagent.status_failed')
  if (block.status === 'done') return t('subagent.status_done')
  return t('subagent.status_working')
}

function shortAgentId(agentId: string): string {
  const normalized = agentId.replace(/^thread:/, '').trim()
  return normalized.length > 8 ? `Agent ${normalized.slice(-8)}` : normalized || 'Agent'
}
