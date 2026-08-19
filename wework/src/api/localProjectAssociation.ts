import type { CloudLoopItem } from '@/api/deliveries'

const LOCAL_PROJECT_TAG_PREFIX = 'wegent:local-project:'

export interface LocalProjectAssociation {
  id: number
  name: string
}

export function localProjectAssociationTag(project: LocalProjectAssociation): string {
  return `${LOCAL_PROJECT_TAG_PREFIX}${project.id}:${encodeURIComponent(project.name)}`
}

export function localProjectAssociationFromTags(tags: string[]): LocalProjectAssociation | null {
  const tag = tags.find(candidate => candidate.startsWith(LOCAL_PROJECT_TAG_PREFIX))
  if (!tag) return null
  const value = tag.slice(LOCAL_PROJECT_TAG_PREFIX.length)
  const separator = value.indexOf(':')
  const id = Number(separator >= 0 ? value.slice(0, separator) : value)
  if (!Number.isInteger(id) || id <= 0) return null
  const encodedName = separator >= 0 ? value.slice(separator + 1) : ''
  try {
    return { id, name: decodeURIComponent(encodedName) }
  } catch {
    return { id, name: encodedName }
  }
}

export function visibleLoopItemTags(tags: string[]): string[] {
  return tags.filter(tag => !tag.startsWith(LOCAL_PROJECT_TAG_PREFIX))
}

export function loopItemLocalProject(item: CloudLoopItem): LocalProjectAssociation | null {
  if (item.local_project_id) {
    return {
      id: item.local_project_id,
      name: item.local_project_name ?? '',
    }
  }
  return localProjectAssociationFromTags(item.tags ?? [])
}

export function associateLoopItemTags(
  item: Pick<CloudLoopItem, 'tags'>,
  project: LocalProjectAssociation
): string[] {
  return [
    ...(item.tags ?? []).filter(tag => !tag.startsWith(LOCAL_PROJECT_TAG_PREFIX)),
    localProjectAssociationTag(project),
  ]
}
