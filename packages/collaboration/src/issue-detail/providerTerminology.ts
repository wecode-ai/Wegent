import type { CollaborationTranslate } from '../i18n'

const externalLabels: Record<string, string> = {
  github: 'GitHub Issue',
  gitlab: 'GitLab Issue',
  dingtalk_aitable: 'record',
}

/** Provider-owned records retain their source terminology and write path. */
export function providerTerminology(
  provider: string | undefined,
  translate: CollaborationTranslate
): CollaborationTranslate {
  const label = provider ? externalLabels[provider] : undefined
  if (!label) return translate
  const kind = label === 'record' ? translate('todo.external_record', '表格记录') : label
  const keys: Record<string, string> = {
    'todo.new_issue': 'todo.external_new',
    'todo.create_issue': 'todo.external_create',
    'todo.create_issue_failed': 'todo.external_create_failed',
    'todo.issue_detail': 'todo.external_detail',
    'todo.issue_description': 'todo.external_description',
    'todo.parent_issue': 'todo.external_parent',
    'todo.no_parent_issue': 'todo.external_no_parent',
    'todo.top_level_issue': 'todo.external_no_parent',
    'todo.search_parent_issue': 'todo.external_search_parent',
    'todo.no_matching_parent_issue': 'todo.external_no_matching_parent',
  }
  const scoped: CollaborationTranslate = (key, fallback, options) =>
    keys[key]
      ? translate(keys[key]!, fallback, { ...options, kind })
      : translate(key, fallback, options)
  scoped.locale = translate.locale
  return scoped
}
