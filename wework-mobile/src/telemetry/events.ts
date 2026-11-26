export type MobileTelemetryResult = 'success' | 'failure' | 'cancelled'
export type MobileExecutionTarget = 'local' | 'remote' | 'unknown'
export type MobileTelemetryFailureReason =
  'network_error' | 'model_error' | 'runtime_error' | 'unknown'

export const MOBILE_SCREENS = [
  'conversation_list',
  'conversation',
  'archived_conversations',
  'settings',
  'models',
  'local_execution',
  'login',
  'privacy',
] as const
export type MobileScreen = (typeof MOBILE_SCREENS)[number]

export type MobileAnalyticsEventMap = {
  mobile_app_installed: {
    is_first_launch: boolean
    since_install_ms: number
  }
  mobile_app_updated: {
    from_version: string
    to_version: string
  }
  mobile_app_opened: {
    cold_start: boolean
    launch_count: number
    is_first_launch: boolean
    since_install_ms: number
  }
  mobile_foreground_started: {
    resumed: boolean
  }
  mobile_foreground_ended: {
    duration_ms: number
    termination: 'background'
  }
  mobile_session_abnormal_end: {
    duration_ms: number
  }
  mobile_frame_health: {
    duration_ms: number
    total_frames: number
    rendered_frames: number
    jank_frames: number
    jank_rate: number
    max_stall_ms: number
    stalls_over_100ms: number
    stalls_over_500ms: number
  }
  mobile_startup_completed: {
    duration_ms: number
  }
  mobile_screen_viewed: {
    screen: MobileScreen
  }
  mobile_task_started: {
    execution_target: MobileExecutionTarget
    run_count: number
  }
  mobile_task_completed: {
    duration_ms: number
    execution_target: MobileExecutionTarget
    result: MobileTelemetryResult
    failure_reason?: MobileTelemetryFailureReason
    run_count: number
  }
  mobile_task_retried: {
    execution_target: MobileExecutionTarget
    previous_result: MobileTelemetryResult
    since_last_ms: number
  }
  mobile_telemetry_preference_changed: {
    enabled: true
  }
}

export type MobileAnalyticsEventName = keyof MobileAnalyticsEventMap

export const MOBILE_ANALYTICS_EVENT_PROPERTY_KEYS: {
  [EventName in MobileAnalyticsEventName]: readonly (keyof MobileAnalyticsEventMap[EventName])[]
} = {
  mobile_app_installed: ['is_first_launch', 'since_install_ms'],
  mobile_app_updated: ['from_version', 'to_version'],
  mobile_app_opened: ['cold_start', 'launch_count', 'is_first_launch', 'since_install_ms'],
  mobile_foreground_started: ['resumed'],
  mobile_foreground_ended: ['duration_ms', 'termination'],
  mobile_session_abnormal_end: ['duration_ms'],
  mobile_frame_health: [
    'duration_ms',
    'total_frames',
    'rendered_frames',
    'jank_frames',
    'jank_rate',
    'max_stall_ms',
    'stalls_over_100ms',
    'stalls_over_500ms',
  ],
  mobile_startup_completed: ['duration_ms'],
  mobile_screen_viewed: ['screen'],
  mobile_task_started: ['execution_target', 'run_count'],
  mobile_task_completed: [
    'duration_ms',
    'execution_target',
    'result',
    'failure_reason',
    'run_count',
  ],
  mobile_task_retried: ['execution_target', 'previous_result', 'since_last_ms'],
  mobile_telemetry_preference_changed: ['enabled'],
}

export const MOBILE_ANALYTICS_COMMON_PROPERTY_KEYS = [
  '$geoip_disable',
  'app_build',
  'app_version',
  'environment',
  'event_schema_version',
  'locale',
  'os',
  'os_version',
  'platform',
  'release_channel',
  'telemetry_sample_rate',
  'telemetry_session_id',
  'telemetry_source',
] as const

export const POSTHOG_TRANSPORT_PROPERTY_KEYS = [
  '$device_id',
  '$lib',
  '$lib_version',
  '$process_person_profile',
  '$session_id',
  '$window_id',
  'distinct_id',
  'token',
] as const

export function isMobileAnalyticsEventName(value: string): value is MobileAnalyticsEventName {
  return Object.prototype.hasOwnProperty.call(MOBILE_ANALYTICS_EVENT_PROPERTY_KEYS, value)
}

export function parseMobileScreen(value: string | undefined): MobileScreen | null {
  if (!value) return null
  const screens: Readonly<Record<string, MobileScreen>> = {
    archives: 'archived_conversations',
    backendLogin: 'login',
    codexAccount: 'models',
    conversation: 'conversation',
    conversationList: 'conversation_list',
    localExecution: 'local_execution',
    localModels: 'models',
    modelEditor: 'models',
    modelPicker: 'models',
    privacyPolicy: 'privacy',
    provider: 'models',
    providerEditor: 'models',
    settings: 'settings',
    standaloneModelEditor: 'models',
  }
  return screens[value] ?? null
}
