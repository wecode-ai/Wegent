import type { CloudProject } from '@/api/deliveries'

export function usesAgenticStrategy(project: CloudProject | null | undefined): boolean {
  return project?.agentic_strategy_enabled === true && Boolean(project.collaboration_strategy)
}
