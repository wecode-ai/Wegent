import i18n from '@/i18n'
import { getErrorMessage } from './error-message'
import { logRuntimeTaskCreateStage } from './runtime-create-diagnostics'

// Persisted task failures and older Executors may contain only the original message.
const LEGACY_ERROR_CODES: Record<string, string> = {
  'invalid task data: Project-scoped agents can only receive work from their project':
    'stand_in_project_connections',
  'Issue assignment event identity is missing': 'invalid_assignment',
  'Connect this Executor to your cloud account': 'cloud_unavailable',
  "Stand-in can only handle the connected user's assignments": 'permission_denied',
  'projectId is required': 'bad_request',
  'userId is required': 'bad_request',
  'projectStore is required': 'bad_request',
  'Save settings on the selected Executor': 'wrong_device',
  'issueId is required': 'bad_request',
  'Choose an Issue assigned to yourself in this project': 'invalid_assignment',
  'Connect a stand-in to this project first': 'stand_in_unavailable',
  'Issue assignment is unavailable': 'invalid_assignment',
  'Issue is no longer assigned to yourself': 'invalid_assignment',
  'The Stand-in task failed; open its Runtime task to recover': 'stand_in_start_failed',
  'This assignment has already been handled or is no longer active': 'assignment_already_handled',
  'Cloud connection is unavailable': 'cloud_unavailable',
  'Choose Codex for execution-before-confirmation controls': 'confirmation_runtime_unsupported',
  'The personal agent is no longer available to this user': 'permission_denied',
  'The personal agent has no bots': 'agent_unavailable',
  'The personal agent is empty': 'agent_unavailable',
  'Choose a Codex or Claude Code agent': 'unsupported_runtime',
  'The personal agent is inactive': 'agent_unavailable',
  "This role handles tasks only in the selected agent's project": 'agent_project_mismatch',
  'The selected agent is unavailable in this project': 'agent_unavailable',
  'Configure the agent environment and model before enabling Stand-in':
    'agent_configuration_required',
  'The selected agent requires another device': 'agent_device_conflict',
  'The selected agent requires its fixed model': 'agent_model_conflict',
  'proposalId is required': 'bad_request',
  'accept is required': 'bad_request',
  'message is required': 'bad_request',
  'Stand-in role no longer exists': 'role_removed',
  'Cloud model namespace is required': 'model_unavailable',
  'Cloud model owner is required': 'model_unavailable',
  'Select an available Codex model for this conversation': 'model_unavailable',
  "Reselect the task's submitted model interface to restore its credentials": 'model_unavailable',
  'Missing connection events': 'connection_response_invalid',
  'Missing connection checkpoint': 'connection_response_invalid',
  'Connection event is missing required fields': 'connection_response_invalid',
  'Source was disconnected': 'source_removed',
  'The model returned an invalid work association': 'stand_in_grouping_failed',
  'Connection settings changed during collection': 'connection_configuration_changed',
  'Message timestamp is invalid or ambiguous': 'connection_response_invalid',
  'Host is restarting': 'connection_host_unavailable',
  'Authorize the account': 'connector_auth_required',
  'Memory id is required': 'bad_request',
  'Memory version is required': 'bad_request',
  'Unknown memory operation': 'bad_request',
  'enabled is required': 'bad_request',
  'ids must contain at most 100 event IDs': 'bad_request',
  'Invalid event ID': 'bad_request',
  'Work ID is missing': 'bad_request',
  'workId is required': 'bad_request',
  'Role no longer exists': 'role_removed',
  'Work task ID is missing': 'bad_request',
  'Check the work history before starting it again': 'stand_in_dispatch_unknown',
  'The source connection was removed': 'source_removed',
  'Source is not connected': 'source_removed',
  'messageIds is required': 'bad_request',
  'Message ids must be strings': 'bad_request',
  'Wait for active work to finish before organizing messages': 'work_busy',
  'messageId is required': 'bad_request',
  'Stop the running work before changing message associations': 'work_busy',
  'The selected local project is unavailable on this Executor': 'workspace_unavailable',
  'Choose an available directory in the selected local project': 'workspace_unavailable',
  'Worktrees require a Git repository': 'workspace_not_git',
  'Invalid Stand-in execution mode': 'bad_request',
  'Current Executor identity is unavailable': 'stand_in_unavailable',
  'version conflict': 'version_conflict',
  'Device offline': 'device_offline',
  'Executor offline': 'device_offline',
  'Workspace config is invalid': 'workspace_unavailable',
  'Executor identity is unavailable': 'executor_unavailable',
  'local-sidebar-runtime-changed': 'executor_restarted',
}

const TRANSPORT_ERROR_CODES: Record<string, string> = {
  RUNNER_MODEL_UNAVAILABLE: 'model_unavailable',
  executor_disconnected: 'executor_unavailable',
  protocol_mismatch: 'executor_update_required',
  unsupported_method: 'executor_update_required',
  http_401: 'authentication_required',
  http_403: 'permission_denied',
  http_502: 'service_unavailable',
  http_503: 'service_unavailable',
  http_504: 'service_unavailable',
}

/** Upgrade actions depend on structured error codes, never translated copy. */
export function requiresStandInUpgrade(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return (
    code === 'executor_update_required' ||
    (typeof code === 'string' && TRANSPORT_ERROR_CODES[code] === 'executor_update_required')
  )
}

// Device routing emits these prefixes followed by the requested device identity.
const DEVICE_ERROR_CODES: Record<string, string> = {
  'executor-not-found': 'executor_unavailable',
  'executor-offline': 'device_offline',
  'ambiguous-executor-identity': 'executor_ambiguous',
}

/** Log routing and transport identity without request content or raw error messages. */
export function reportStandInError(operation: string, error: unknown, deviceId?: string): void {
  const value = error && typeof error === 'object' ? error : {}
  const code = 'code' in value ? value.code : undefined
  const status = 'status' in value ? value.status : undefined
  const message = getErrorMessage(error, '').replace(/^Error: /, '')
  logRuntimeTaskCreateStage('stand-in-operation-failed', {
    operation,
    deviceId,
    code: typeof code === 'string' && /^[a-z_][a-z0-9_]{0,79}$/i.test(code) ? code : undefined,
    status: typeof status === 'number' && status >= 100 && status <= 599 ? status : undefined,
    routingReason: Object.hasOwn(DEVICE_ERROR_CODES, message.split(':')[0])
      ? message.split(':')[0]
      : undefined,
  })
}

/** Keep protocol errors in diagnostics and present localized recovery guidance. */
export function getStandInErrorMessage(
  error: unknown,
  fallback:
    | 'failed'
    | 'load_settings_failed'
    | 'save_settings_failed'
    | 'load_environment_failed'
    | 'load_projects_failed' = 'failed'
): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const message = getErrorMessage(error, '').replace(/^Error: /, '')
  if (
    typeof code === 'string' &&
    !i18n.exists('common:standIn.errors.' + code) &&
    i18n.exists('common:standIn.git.errors.' + code)
  )
    return i18n.t('common:standIn.git.errors.' + code)
  const knownCode = (value: unknown): value is string =>
    typeof value === 'string' && i18n.exists('common:standIn.errors.' + value)
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  const transportCode = typeof code === 'string' ? TRANSPORT_ERROR_CODES[code] : undefined
  const statusCode =
    typeof status === 'number' ? TRANSPORT_ERROR_CODES[`http_${status}`] : undefined
  const key = knownCode(code)
    ? code
    : (transportCode ??
      statusCode ??
      DEVICE_ERROR_CODES[message.split(':')[0]] ??
      (knownCode(message) ? message : LEGACY_ERROR_CODES[message]))
  if (key) return i18n.t('common:standIn.errors.' + (key === 'failed' ? fallback : key))
  // Already localized validation messages must survive nested UI error boundaries.
  for (const language of ['en', 'zh-CN']) {
    const localized = i18n.getResource(language, 'common', 'standIn.errors')
    if (localized) {
      const entry = Object.entries(localized).find(([, value]) => value === message)
      if (entry)
        return i18n.t('common:standIn.errors.' + (entry[0] === 'failed' ? fallback : entry[0]))
    }
  }
  if (/[\u4e00-\u9fff]/.test(message)) return message
  return i18n.t('common:standIn.errors.' + fallback)
}
