import type { ReactNode } from 'react'
import type {
  CollaborationProjectView,
  CollaborationProjectViewOption,
} from './projectViewNavigation'

const oldTestIds: Partial<Record<CollaborationProjectView, string>> = {
  table: 'collaboration-tab-table',
  files: 'collaboration-tab-files',
  manage: 'collaboration-tab-manage',
}

/** Keep aliases on the visible label inside the real actionable element. */
export function ProjectViewLabel({
  option,
  selected,
}: {
  option: CollaborationProjectViewOption
  selected: boolean
}) {
  const aliases = new Set([
    ...(option.oldTestIdAliases ?? []),
    oldTestIds[option.id],
  ])
  let label: ReactNode = option.label
  for (const alias of aliases) {
    if (alias && alias !== option.testId) {
      label = (
        <span data-testid={alias} aria-current={selected ? 'page' : undefined}>
          {label}
        </span>
      )
    }
  }
  return label
}
