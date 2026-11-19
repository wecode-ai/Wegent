import type { TemplateModelConfiguration } from './TemplateModelSelection'

export function sameTemplateModelScope(
  first: TemplateModelConfiguration | undefined,
  second: TemplateModelConfiguration | undefined
) {
  return Boolean(
    first &&
    second &&
    first.host === second.host &&
    first.location === second.location &&
    first.projectId === second.projectId &&
    first.environmentId === second.environmentId
  )
}
