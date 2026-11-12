import type { CloudProject } from '@/api/deliveries'
import { projectKey } from './projectSpaceSelection'

export interface ProjectSpacePickerGroup {
  key: string
  label: string
}

export interface ProjectSpacePickerEntry {
  key: string
  project: CloudProject
  group: ProjectSpacePickerGroup
}

export type ProjectSpacePickerOrder = 'name-asc' | 'name-desc'

export function projectSpacePickerEntries(
  projects: CloudProject[],
  labels: { local: string; cloud: string },
  grouping: 'storage' | 'workspace' = 'workspace'
): ProjectSpacePickerEntry[] {
  return projects.map(project => {
    const workspace = project.workspace_context
    return {
      key: projectKey(project),
      project,
      group: {
        key:
          grouping === 'workspace' && workspace
            ? `${project.project_store}:${workspace.id}`
            : project.project_store,
        label:
          (grouping === 'workspace' ? workspace?.name : undefined) ??
          labels[project.project_store === 'local' ? 'local' : 'cloud'],
      },
    }
  })
}

export function searchProjectSpaceEntries(
  entries: ProjectSpacePickerEntry[],
  query: string
): ProjectSpacePickerEntry[] {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean)
  return entries.filter(({ project, group }) => {
    const text = normalize(
      `${project.name}\n${group.label}\n${project.workspace_context?.name ?? ''}\n${project.project_key}\n${project.public_id}`
    )
    return terms.every(term => text.includes(term))
  })
}

export function sortProjectSpaceEntries(
  entries: ProjectSpacePickerEntry[],
  order: ProjectSpacePickerOrder,
  locale: string
): ProjectSpacePickerEntry[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  const direction = order === 'name-asc' ? 1 : -1
  return [...entries].sort(
    (left, right) =>
      direction * collator.compare(left.project.name, right.project.name) ||
      collator.compare(
        left.project.workspace_context?.name ?? left.group.label,
        right.project.workspace_context?.name ?? right.group.label
      ) ||
      collator.compare(left.key, right.key)
  )
}
