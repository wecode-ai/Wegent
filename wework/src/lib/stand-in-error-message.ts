import i18n from '@/i18n'
import { getErrorMessage } from './error-message'

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
}

/** Keep protocol errors in diagnostics and present localized recovery guidance. */
export function getStandInErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const message = getErrorMessage(error, '').replace(/^Error: /, '')
  const knownCode = (value: unknown): value is string =>
    typeof value === 'string' && i18n.exists('common:standIn.errors.' + value)
  const key = knownCode(code) ? code : knownCode(message) ? message : LEGACY_ERROR_CODES[message]
  if (key) return i18n.t('common:standIn.errors.' + key)
  // Already localized validation messages must survive nested UI error boundaries.
  for (const language of ['en', 'zh-CN']) {
    const localized = i18n.getResource(language, 'common', 'standIn.errors')
    if (localized) {
      const entry = Object.entries(localized).find(([, value]) => value === message)
      if (entry) return i18n.t('common:standIn.errors.' + entry[0])
    }
  }
  if (/[\u4e00-\u9fff]/.test(message)) return message
  return i18n.t('common:standIn.errors.failed')
}
