// Maps raw event-type identifiers to natural-language, i18n-aware labels so the
// automation UI never surfaces identifiers such as "change_request.checks_failed".
// Add a new identifier here and in the corresponding i18n namespace instead of
// branching at each call site.
const EVENT_TYPE_LABEL_KEYS: Record<string, string> = {
  'task.created': 'todo.event_type_task_created',
  'task.status_changed': 'todo.event_type_task_status_changed',
  'change_request.checks_failed': 'todo.event_type_checks_failed',
  'change_request.merge_conflict': 'todo.event_type_merge_conflict',
  'change_request.review_submitted': 'todo.event_type_review_submitted',
  'change_request.comment_created': 'todo.event_type_comment_created',
  'change_request.merged': 'todo.event_type_merged',
  'document.changed': 'todo.event_type_document_changed',
}

// Resolves an event-type identifier to its natural-language label. A translator
// must be provided; without one the identifier is kept verbatim as a graceful
// fallback so unknown or untranslated types still render without breaking.
export function eventTypeLabel(eventType: string, t?: (key: string) => string): string {
  const key = EVENT_TYPE_LABEL_KEYS[eventType]
  if (!key || !t) return eventType
  return t(key)
}
