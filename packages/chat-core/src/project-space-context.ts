import type { RuntimeAdditionalContext } from './runtime-task-api-types'
export interface ProjectSpaceContext {
  id: string
  name: string
  project_key: string
  project_store: 'local' | 'backend'
  task_provider: string
  provider_config: {
    base_id?: unknown
    table_id?: unknown
    view_id?: unknown
    board_mapping?: unknown
  }
}
export interface ProjectSpaceItemContext {
  id: string
  title: string
  description?: string | null
  source_record_id?: string | null
  source_cells?: Record<string, unknown> | null
}
function contextString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

export function dingtalkAITableRuntimeContext(
  project: ProjectSpaceContext,
  item?: ProjectSpaceItemContext
): RuntimeAdditionalContext | undefined {
  if (project.task_provider !== 'dingtalk_aitable') return undefined
  const baseId = contextString(project.provider_config.base_id)
  const tableId = contextString(project.provider_config.table_id)
  if (!baseId || !tableId) return undefined
  const viewId = contextString(project.provider_config.view_id)
  const recordId =
    item?.source_record_id?.trim() ||
    (item?.id.startsWith('aitable:') ? item.id.split(':').at(-1)?.trim() : undefined)
  const binding = {
    default_target: {
      space_id: String(project.id),
      space_name: project.name,
      project_key: project.project_key,
      provider: 'dingtalk_aitable',
      dws_product: 'aitable',
      base_id: baseId,
      table_id: tableId,
      ...(viewId ? { view_id: viewId } : {}),
      ...(project.provider_config.board_mapping
        ? { board_mapping: project.provider_config.board_mapping }
        : {}),
      ...(recordId && item
        ? {
            current_item: {
              item_id: String(item.id),
              record_id: recordId,
              title: item.title,
              cached_description: item.description ?? '',
              cached_cells: item.source_cells ?? {},
            },
          }
        : {}),
    },
    semantics: {
      board_item: 'aitable_record',
      source_of_truth: 'dingtalk',
    },
    resolution_policy: {
      implicit_reference: 'use_default_target',
      named_space_reference: 'list_spaces_then_use_that_space_binding',
      explicit_dingtalk_search: 'allow_provider_search',
      ambiguous_reference: 'ask_or_list_candidates',
      bound_target_failure: 'report_error_without_switching_resources',
    },
  }
  const rules = [
    'The project resource binding above is authoritative.',
    'For an implicit reference such as "this project" or "my tasks", use the wework_space tools with the bound project and item IDs. Do not search or list DingTalk bases first.',
    "If the user explicitly names another Wework project, use wework_space list_spaces to resolve it, then use that project's provider binding.",
    'Only search DingTalk bases when the user explicitly asks to find an arbitrary DingTalk resource outside the bound Wework project.',
    'Inspect the live table schema before referring to fields. Never guess identifiers or field names.',
    ...(recordId
      ? [
          'For questions about the current Issue, call wework_space get_current_context first so the provider can return the live DingTalk record fields and primary document.',
          `The bound record ID is ${recordId}; never search for the current record by title.`,
          'Only when the project-space tool explicitly returns a bundled_dws_fallback may you use the exact binary path and commands from that fallback.',
          'Never invoke a bare dws command or use a user-installed DWS.',
        ]
      : []),
    'If the bound resource cannot be accessed, report that error and do not silently switch to another table.',
    'Follow project-space tool confirmation requirements for destructive operations.',
  ]
  return {
    dingtalkAITableProject: {
      kind: 'application',
      value: [
        '<project_resource_binding version="1">',
        JSON.stringify(binding, null, 2),
        '</project_resource_binding>',
        '',
        ...rules,
      ].join('\n'),
    },
  }
}

export function projectSpaceChatRuntimeContext(
  project: ProjectSpaceContext,
  item?: ProjectSpaceItemContext
): RuntimeAdditionalContext {
  return {
    projectSpaceChat: {
      kind: 'application',
      value: [
        '<current_project_space>',
        JSON.stringify({ id: String(project.id), name: project.name }),
        '</current_project_space>',
        'This is a normal chat bound to the current Wework project space, not a goal or task-mode session.',
        'Unqualified references such as "this project", "tasks", "issues", or "how many tasks" mean the board items in this current project space.',
        'For those requests, use the configured project task-provider tools directly. Do not ask which category of task the user means.',
        'Use wework_space for Wework project-space data, unless another provider-specific application context directs you to its bound tool.',
        'Only ask the user to clarify when their request is ambiguous within the current project itself.',
      ].join('\n'),
    },
    ...dingtalkAITableRuntimeContext(project, item),
  }
}
