export const MAX_RUNTIME_TASK_TITLE_LENGTH = 60

export function truncateRuntimeTaskTitle(title: string | null | undefined): string | null {
  const normalizedTitle = title?.trim()
  if (!normalizedTitle) return null

  const characters = Array.from(normalizedTitle)
  if (characters.length <= MAX_RUNTIME_TASK_TITLE_LENGTH) return normalizedTitle

  return `${characters.slice(0, MAX_RUNTIME_TASK_TITLE_LENGTH - 1).join('')}…`
}
