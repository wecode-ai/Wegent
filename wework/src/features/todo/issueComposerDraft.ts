import { buildRuntimeTaskTitle } from '@/features/workbench/workbenchRuntimeHelpers'

export function issueDraftFromText(value: string): { title: string; description: string } {
  const description = value.trim()
  return {
    title: description ? buildRuntimeTaskTitle(description) : '',
    description,
  }
}
