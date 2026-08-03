export type ExecutionTarget = 'local' | 'cloud' | 'unknown'
export type TelemetryResult = 'success' | 'cancelled' | 'failure'
export type TelemetryFailureReason = 'network_error' | 'model_error' | 'runtime_error' | 'unknown'
export type TelemetryDataSource = 'local' | 'cloud' | 'unknown'

export interface AnalyticsEventMap {
  app_started: {
    surface: 'main' | 'popout' | 'workspace'
  }
  project_opened: {
    source: 'local' | 'cloud' | 'unknown'
  }
  conversation_created: {
    execution_target: ExecutionTarget
  }
  task_started: {
    execution_target: ExecutionTarget
  }
  first_response_completed: {
    duration_ms: number
    execution_target: ExecutionTarget
    result: TelemetryResult
  }
  task_completed: {
    duration_ms: number
    execution_target: ExecutionTarget
    failure_reason?: TelemetryFailureReason
    result: TelemetryResult
  }
  telemetry_preference_changed: {
    enabled: true
  }
  board_view_opened: {
    source: TelemetryDataSource
    view: 'board' | 'table' | 'files' | 'manage'
  }
  board_item_created: {
    has_parent: boolean
    source: TelemetryDataSource
  }
  board_item_moved: {
    group_by: 'status' | 'priority' | 'assignee' | 'tag'
    reordered: boolean
    source: TelemetryDataSource
  }
  plugin_center_opened: {
    surface: 'catalog' | 'management'
  }
  plugin_installed: {
    source: TelemetryDataSource
  }
  plugin_enabled_changed: {
    enabled: boolean
    scope: 'plugin' | 'component'
    source: TelemetryDataSource
  }
  plugin_uninstalled: {
    source: TelemetryDataSource
  }
  feature_opened: {
    feature:
      | 'workbench'
      | 'project_space'
      | 'plugins'
      | 'plugin_management'
      | 'plugin_create'
      | 'cloud_work'
      | 'sites'
      | 'automations'
      | 'apps'
      | 'settings'
      | 'login'
      | 'popout'
      | 'unknown'
  }
  project_created: {
    kind: 'standard' | 'git'
  }
  project_removed: {
    source: TelemetryDataSource
  }
  automation_action_completed: {
    action: 'create' | 'update' | 'enable' | 'disable' | 'run' | 'delete'
  }
  feedback_submitted: {
    attachment_count: '0' | '1' | '2-5' | '6+'
  }
  appshot_received: {
    attachment_count: '1' | '2-5' | '6+'
  }
  browser_navigation_completed: {
    runtime: 'embedded' | 'fallback'
  }
  browser_download_completed: {
    result: 'success' | 'failure' | 'cancelled'
  }
  cloud_connection_changed: {
    connected: boolean
  }
  delivery_completed: {
    asset_count: '0' | '1' | '2-5' | '6+'
    includes_chat: boolean
  }
  app_update_install_started: Record<string, never>
  authentication_completed: {
    method: 'password' | 'oidc' | 'admin_setup'
    result: 'success' | 'failure'
  }
  quick_phrase_used: {
    mode: 'normal' | 'plan' | 'goal'
  }
  operation_failed: {
    operation:
      | 'board_item_move'
      | 'plugin_install'
      | 'plugin_uninstall'
      | 'plugin_toggle'
      | 'automation_save'
      | 'automation_toggle'
      | 'automation_run'
      | 'automation_delete'
      | 'cloud_connect'
      | 'delivery'
      | 'feedback'
      | 'skill_action'
      | 'mcp_action'
      | 'site_action'
      | 'project_space_file_action'
      | 'table_action'
      | 'project_space_action'
      | 'hook_action'
      | 'git_action'
      | 'model_action'
      | 'plugin_action'
      | 'board_item_action'
      | 'task_binding_action'
      | 'task_workspace_file_action'
      | 'quick_phrase_action'
      | 'cloud_device_action'
      | 'archived_conversation_action'
      | 'attachment_action'
      | 'workspace_file_action'
      | 'conversation_archive'
  }
  feature_action_completed: {
    action:
      | 'install'
      | 'upload'
      | 'create'
      | 'enable'
      | 'disable'
      | 'uninstall'
      | 'configure'
      | 'publish'
      | 'delete'
      | 'open'
      | 'move'
      | 'update'
      | 'rename'
      | 'save_grouping'
      | 'member_invite'
      | 'member_role_change'
      | 'member_remove'
      | 'test'
      | 'commit'
      | 'push'
      | 'commit_push'
      | 'checkout'
      | 'branch_create'
      | 'bind'
      | 'unbind'
      | 'restore'
      | 'archive'
    domain:
      | 'skill'
      | 'mcp'
      | 'site'
      | 'project_space_file'
      | 'table_record'
      | 'table_field'
      | 'project_space'
      | 'hook'
      | 'git'
      | 'model'
      | 'plugin'
      | 'board_item'
      | 'task_binding'
      | 'task_workspace_file'
      | 'quick_phrase'
      | 'cloud_device'
      | 'archived_conversation'
      | 'attachment'
      | 'workspace_file'
      | 'conversation'
  }
  workspace_panel_added: {
    panel: 'review' | 'terminal' | 'browser' | 'chat' | 'files' | 'desktop' | 'other'
  }
}

export type AnalyticsEventName = keyof AnalyticsEventMap

export const ANALYTICS_EVENT_PROPERTY_KEYS: {
  [EventName in AnalyticsEventName]: ReadonlyArray<keyof AnalyticsEventMap[EventName]>
} = {
  app_started: ['surface'],
  project_opened: ['source'],
  conversation_created: ['execution_target'],
  task_started: ['execution_target'],
  first_response_completed: ['duration_ms', 'execution_target', 'result'],
  task_completed: ['duration_ms', 'execution_target', 'failure_reason', 'result'],
  telemetry_preference_changed: ['enabled'],
  board_view_opened: ['source', 'view'],
  board_item_created: ['has_parent', 'source'],
  board_item_moved: ['group_by', 'reordered', 'source'],
  plugin_center_opened: ['surface'],
  plugin_installed: ['source'],
  plugin_enabled_changed: ['enabled', 'scope', 'source'],
  plugin_uninstalled: ['source'],
  feature_opened: ['feature'],
  project_created: ['kind'],
  project_removed: ['source'],
  automation_action_completed: ['action'],
  feedback_submitted: ['attachment_count'],
  appshot_received: ['attachment_count'],
  browser_navigation_completed: ['runtime'],
  browser_download_completed: ['result'],
  cloud_connection_changed: ['connected'],
  delivery_completed: ['asset_count', 'includes_chat'],
  app_update_install_started: [],
  authentication_completed: ['method', 'result'],
  quick_phrase_used: ['mode'],
  operation_failed: ['operation'],
  feature_action_completed: ['action', 'domain'],
  workspace_panel_added: ['panel'],
}

export interface CommonTelemetryProperties {
  app_version: string
  arch: 'arm64' | 'x64' | 'unknown'
  locale: string
  os: 'mac' | 'win' | 'linux'
  release_channel: string
  runtime_mode: 'local-first' | 'backend'
  telemetry_session_id: string
}

export interface QueuedAnalyticsEvent<EventName extends AnalyticsEventName = AnalyticsEventName> {
  name: EventName
  properties: AnalyticsEventMap[EventName]
}
