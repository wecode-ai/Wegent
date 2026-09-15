import { useTranslation } from '@/hooks/useTranslation'
import type { SubagentBlock } from '@/types/workbench'
import { getSubagentName } from './subagentPresentation'

interface SubagentActivityGroupProps {
  blocks: SubagentBlock[]
  onOpenSubagent?: (block: SubagentBlock) => void
}

export function SubagentActivityGroup({ blocks, onOpenSubagent }: SubagentActivityGroupProps) {
  const { t } = useTranslation('chat')

  if (blocks.length === 0) return null

  return (
    <section
      className="flex min-w-0 flex-wrap items-center gap-2"
      aria-label={t('subagent.activity')}
      data-testid="subagent-activity-inline-group"
    >
      {blocks.map(block => {
        const name = getSubagentName(block, t)
        const content = (
          <>
            <SubagentAvatar block={block} label={name} className="h-4 w-4" />
            <span className="max-w-56 truncate">{name}</span>
          </>
        )
        const className =
          'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-muted px-2 text-sm text-text-secondary'

        return onOpenSubagent ? (
          <button
            key={block.id}
            type="button"
            className={`${className} cursor-pointer hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2`}
            aria-label={t('subagent.open_agent', { name })}
            title={name}
            onClick={() => onOpenSubagent(block)}
            data-testid="subagent-activity-chip"
          >
            {content}
          </button>
        ) : (
          <span
            key={block.id}
            className={className}
            title={name}
            data-testid="subagent-activity-chip"
          >
            {content}
          </span>
        )
      })}
      <span className="text-sm text-text-secondary" data-testid="subagent-activity-status">
        {getSubagentGroupStatus(blocks, t)}
      </span>
    </section>
  )
}

function getSubagentGroupStatus(
  blocks: SubagentBlock[],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (blocks.some(block => block.status !== 'done' && block.status !== 'error')) {
    return t('subagent.status_working')
  }
  if (blocks.some(block => block.agentStatus === 'interrupted')) {
    return t('subagent.status_interrupted')
  }
  if (blocks.some(block => block.status === 'error')) {
    return t('subagent.status_failed')
  }
  return t('subagent.status_done')
}

export function SubagentAvatar({
  block,
  label,
  className = 'h-4 w-4',
}: {
  block: SubagentBlock
  label: string
  className?: string
}) {
  const seed = block.agentThreadId || block.agentId || block.id

  return (
    <span
      className={`flex ${className} shrink-0 items-center justify-center rounded-full bg-text-primary text-xs font-medium leading-none text-background`}
      data-avatar-seed={seed}
      aria-hidden="true"
    >
      {Array.from(label.trim())[0]?.toUpperCase() || 'A'}
    </span>
  )
}
