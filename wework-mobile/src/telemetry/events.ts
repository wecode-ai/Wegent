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

const MOBILE_LABEL_PATTERN = /^[A-Za-z0-9._-]{1,48}$/
const MOBILE_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/
const MOBILE_LOCALE_PATTERN = /^[A-Za-z0-9._+@-]{1,64}$/
const MOBILE_SESSION_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const MOBILE_BOUNDED_STRING_PATTERN = /^[^\s]{1,256}$/

const MOBILE_ENUM_PROPERTY_VALUES: Readonly<Record<string, readonly string[]>> = {
  execution_target: ['local', 'remote', 'unknown'],
  failure_reason: ['network_error', 'model_error', 'runtime_error', 'unknown'],
  result: ['success', 'failure', 'cancelled'],
  screen: MOBILE_SCREENS,
  termination: ['background'],
}

const MOBILE_BOOLEAN_PROPERTY_KEYS = new Set([
  '$process_person_profile',
  'cold_start',
  'enabled',
  'is_first_launch',
  'resumed',
])

const MOBILE_INTEGER_PROPERTY_RANGES: Readonly<Record<string, { min: number; max: number }>> = {
  duration_ms: { min: 0, max: Number.MAX_SAFE_INTEGER },
  jank_frames: { min: 0, max: Number.MAX_SAFE_INTEGER },
  launch_count: { min: 1, max: Number.MAX_SAFE_INTEGER },
  max_stall_ms: { min: 0, max: Number.MAX_SAFE_INTEGER },
  rendered_frames: { min: 1, max: Number.MAX_SAFE_INTEGER },
  run_count: { min: 1, max: Number.MAX_SAFE_INTEGER },
  since_install_ms: { min: 0, max: Number.MAX_SAFE_INTEGER },
  since_last_ms: { min: 0, max: Number.MAX_SAFE_INTEGER },
  stalls_over_100ms: { min: 0, max: Number.MAX_SAFE_INTEGER },
  stalls_over_500ms: { min: 0, max: Number.MAX_SAFE_INTEGER },
  total_frames: { min: 1, max: Number.MAX_SAFE_INTEGER },
}

const MOBILE_NUMBER_PROPERTY_RANGES: Readonly<Record<string, { min: number; max: number }>> = {
  event_schema_version: { min: 1, max: 1 },
  jank_rate: { min: 0, max: 1 },
  telemetry_sample_rate: { min: 0, max: 1 },
}

const MOBILE_STRING_PROPERTY_RULES: Readonly<
  Record<string, { maxLength: number; pattern: RegExp }>
> = {
  $device_id: { maxLength: 256, pattern: MOBILE_BOUNDED_STRING_PATTERN },
  $lib: { maxLength: 256, pattern: MOBILE_BOUNDED_STRING_PATTERN },
  $lib_version: { maxLength: 256, pattern: MOBILE_BOUNDED_STRING_PATTERN },
  $session_id: { maxLength: 256, pattern: MOBILE_BOUNDED_STRING_PATTERN },
  $window_id: { maxLength: 256, pattern: MOBILE_BOUNDED_STRING_PATTERN },
  app_build: { maxLength: 64, pattern: MOBILE_VERSION_PATTERN },
  app_version: { maxLength: 64, pattern: MOBILE_VERSION_PATTERN },
  distinct_id: { maxLength: 128, pattern: MOBILE_SESSION_PATTERN },
  environment: { maxLength: 48, pattern: MOBILE_LABEL_PATTERN },
  from_version: { maxLength: 64, pattern: MOBILE_VERSION_PATTERN },
  locale: { maxLength: 64, pattern: MOBILE_LOCALE_PATTERN },
  os: { maxLength: 48, pattern: MOBILE_LABEL_PATTERN },
  os_version: { maxLength: 64, pattern: MOBILE_VERSION_PATTERN },
  platform: { maxLength: 48, pattern: MOBILE_LABEL_PATTERN },
  release_channel: { maxLength: 48, pattern: MOBILE_LABEL_PATTERN },
  telemetry_session_id: { maxLength: 128, pattern: MOBILE_SESSION_PATTERN },
  telemetry_source: { maxLength: 48, pattern: MOBILE_LABEL_PATTERN },
  to_version: { maxLength: 64, pattern: MOBILE_VERSION_PATTERN },
  token: { maxLength: 256, pattern: MOBILE_BOUNDED_STRING_PATTERN },
}

export function isValidMobileAnalyticsProperty(key: string, value: unknown): boolean {
  if (key === '$geoip_disable') return value === true
  const enumValues = MOBILE_ENUM_PROPERTY_VALUES[key]
  if (enumValues) return typeof value === 'string' && enumValues.includes(value)
  if (MOBILE_BOOLEAN_PROPERTY_KEYS.has(key)) return typeof value === 'boolean'
  const integerRange = MOBILE_INTEGER_PROPERTY_RANGES[key]
  if (integerRange) {
    return (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= integerRange.min &&
      value <= integerRange.max
    )
  }
  const numberRange = MOBILE_NUMBER_PROPERTY_RANGES[key]
  if (numberRange) {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= numberRange.min &&
      value <= numberRange.max
    )
  }
  const stringRule = MOBILE_STRING_PROPERTY_RULES[key]
  return Boolean(
    stringRule &&
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= stringRule.maxLength &&
    stringRule.pattern.test(value)
  )
}
