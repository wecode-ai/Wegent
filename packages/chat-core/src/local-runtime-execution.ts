import type { Attachment } from './runtime'
import type { RuntimeProjectPluginRef, RuntimeTaskCreateIntent } from './runtime-task-api-types'
import { createRuntimeTaskIdFromSeed } from './runtime-task-identity'
import { runtimePermissionMode, runtimePermissionProfile } from './runtime-permission'

const WEWORK_EXECUTION_IDENTITY = { id: 0, name: 'Wework' }

export interface LocalRuntimeExecutionInput {
  taskId?: string | null
  runtime: string
  runtimeExecutablePath?: string
  runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
  title: string
  message: string
  bot?: Array<Record<string, unknown>>
  turnSeed: number
  modelOptions?: RuntimeTaskCreateIntent['modelOptions']
  modelConfig: Record<string, unknown>
  reasoningConfig: Record<string, string> | null
  cloudModelGateway?: { backendUrl?: string; apiKey: string }
  additionalSkills?: Array<string | { name: string; namespace: string; is_public: boolean }>
  additionalContext?: RuntimeTaskCreateIntent['additionalContext']
  attachments?: RuntimeTaskCreateIntent['attachments']
  localDeviceId: string
  executionDeviceId?: string
  workspacePath?: string | null
  standaloneChatWorkspace?: boolean
  runtimeProjectKey?: string
  runtimeProjectName?: string
  runtimeWorkspaceRoots?: string[]
  projectInstructions?: string
  projectPlugins?: RuntimeProjectPluginRef[]
  cloudProjectId?: string
  origin?: RuntimeTaskCreateIntent['origin']
  workspaceSource: 'local_path' | 'git_worktree'
  branch?: string | null
  newSession: boolean
  clientUserMessageId?: string
  ephemeral?: boolean
  user: { id: number; user_name: string; email: string }
}

/** Build the canonical executor payload after the host resolves models and network settings. */
export function buildLocalRuntimeExecutionRequest(
  input: LocalRuntimeExecutionInput
): Record<string, unknown> {
  const baseSeed = input.taskId || `${input.runtime}:${input.workspacePath ?? ''}:${input.message}`
  const [derivedTaskId, subtaskId] = createRuntimeExecutionIdsFromSeed(
    input.newSession ? baseSeed : `${baseSeed}:${input.turnSeed}`
  )
  const taskId = input.taskId || derivedTaskId
  const claudeRuntime = ['claude', 'claudecode', 'claude_code'].includes(
    input.runtime.trim().toLowerCase()
  )
  const collaborationMode =
    runtimeCollaborationMode(input.modelOptions) || stringValue(input.origin?.collaborationMode)
  const skillNames = Array.from(
    new Set([...(input.additionalSkills ?? []).map(skillName).filter(isNonEmptyString)])
  )
  const requiredSkillNames = input.additionalContext?.dingtalkAITableProject ? ['dws'] : []
  const deployedSkillNames = Array.from(new Set([...skillNames, ...requiredSkillNames]))
  const preloadSkills = [...(input.additionalSkills ?? []), ...requiredSkillNames]
  const workspaceProject = input.workspacePath
    ? {
        source: input.workspaceSource,
        path: input.workspacePath,
        ...(input.branch ? { branch: input.branch } : {}),
      }
    : null

  return {
    task_id: taskId,
    subtask_id: subtaskId,
    team_id: WEWORK_EXECUTION_IDENTITY.id,
    team_name: WEWORK_EXECUTION_IDENTITY.name,
    team_namespace: 'default',
    task_title: input.title,
    subtask_title: `${input.title} - Assistant`,
    user: {
      id: input.user.id,
      name: input.user.user_name,
      user_name: input.user.user_name,
      email: input.user.email,
    },
    user_id: input.user.id,
    user_name: input.user.user_name,
    ...(input.cloudModelGateway?.backendUrl
      ? {
          backend_url: input.cloudModelGateway.backendUrl,
          auth_token: input.cloudModelGateway.apiKey,
        }
      : {}),
    bot: input.bot ?? [{ id: 0, shell_type: claudeRuntime ? 'ClaudeCode' : 'Codex' }],
    ...(input.runtimeExecutablePath
      ? { runtime_executable_path: input.runtimeExecutablePath }
      : {}),
    ...(input.runtimePermissionMode ? { claude_permission_mode: input.runtimePermissionMode } : {}),
    mcp_servers: [],
    model_config: input.modelConfig,
    system_prompt: input.projectInstructions?.trim() ?? '',
    project_plugin_ids: (input.projectPlugins ?? []).map(plugin => plugin.id),
    prompt: claudeRuntime
      ? claudeMessageWithApplicationContext(
          input.message,
          input.additionalContext,
          input.origin?.type !== 'project_automation'
        )
      : input.message,
    additionalContext: input.additionalContext,
    enable_tools: true,
    enable_deep_thinking: true,
    skill_names: deployedSkillNames,
    preload_skills: preloadSkills,
    user_selected_skills: preloadSkills,
    additional_skills: input.additionalSkills ?? [],
    ...(workspaceProject
      ? {
          workspace: {
            project: workspaceProject,
          },
          workspace_source: input.workspaceSource,
          project_workspace_path: input.workspacePath,
        }
      : {}),
    ...(input.standaloneChatWorkspace ? { standalone_chat_workspace: true } : {}),
    ...(input.runtimeProjectKey ? { runtime_project_key: input.runtimeProjectKey } : {}),
    ...(input.runtimeProjectName ? { runtime_project_name: input.runtimeProjectName } : {}),
    ...(input.runtimeWorkspaceRoots?.length
      ? { runtime_workspace_roots: input.runtimeWorkspaceRoots }
      : {}),
    ...(input.cloudProjectId ? { cloudProjectId: input.cloudProjectId } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    execution_target_type: 'local',
    device_id: input.localDeviceId,
    ...(input.executionDeviceId ? { execution_device_id: input.executionDeviceId } : {}),
    new_session: input.newSession,
    ...(input.clientUserMessageId ? { client_user_message_id: input.clientUserMessageId } : {}),
    ephemeral: Boolean(input.ephemeral),
    is_group_chat: false,
    ...(collaborationMode ? { collaborationMode } : {}),
    mode: 'code',
    task_mode: 'code',
    attachments: localRuntimeAttachments(input.attachments, subtaskId),
    reasoning_config: input.reasoningConfig,
    runtime_permission_profile: runtimePermissionProfile(runtimePermissionMode(input.modelOptions)),
  }
}

export function createRuntimeExecutionIdsFromSeed(seed: string): [string, string] {
  const taskId = createRuntimeTaskIdFromSeed(seed)
  return [taskId, `${taskId}-0`]
}

export function createRuntimeTurnSeed(): number {
  return Math.floor(Date.now() * 1000 + Math.floor(Math.random() * 1000))
}

function runtimeCollaborationMode(modelOptions?: Record<string, string>): string | null {
  return modelOptions?.collaborationMode || modelOptions?.collaboration_mode || null
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

type LocalRuntimeAttachmentPayload = Record<string, unknown> & {
  id: number
  filename: string
  original_filename: string
  file_size: number
  mime_type: string
  status: Attachment['status']
  subtask_id: string
  file_extension: string
  local_path?: string
  local_preview_url?: string
  text_length?: number
  text_preview?: string
}

function localRuntimeAttachments(
  attachments: RuntimeTaskCreateIntent['attachments'],
  subtaskId: string
): Record<string, unknown>[] {
  if (!attachments?.length) return []
  const runtimeAttachments: LocalRuntimeAttachmentPayload[] = []

  attachments.forEach(attachment => {
    const localPath = stringValue(attachment.local_path)
    if (!localPath && attachment.id <= 0) return

    runtimeAttachments.push({
      id: attachment.id,
      filename: attachment.filename,
      original_filename: attachment.filename,
      file_size: attachment.file_size,
      mime_type: attachment.mime_type,
      status: attachment.status,
      subtask_id: attachment.subtask_id ?? subtaskId,
      file_extension: attachment.file_extension,
      ...(localPath
        ? {
            local_path: localPath,
            local_preview_url: attachment.local_preview_url ?? localPath,
          }
        : {}),
      ...(attachment.text_length != null ? { text_length: attachment.text_length } : {}),
      ...(attachment.text_preview ? { text_preview: attachment.text_preview } : {}),
    })
  })

  return runtimeAttachments
}

function skillName(skill: unknown): string | null {
  if (typeof skill === 'string') return skill
  const skillRecord = recordValue(skill)
  return stringValue(skillRecord.name)
}

function isNonEmptyString(value: string | null): value is string {
  return Boolean(value)
}

function claudeMessageWithApplicationContext(
  message: string,
  context?: RuntimeTaskCreateIntent['additionalContext'],
  includeImplicitProjectSpaceCapability = true
): string {
  const entries = Object.entries(context ?? {}).filter(([, entry]) => entry.kind === 'application')
  if (
    includeImplicitProjectSpaceCapability &&
    message.includes('cloud://projects') &&
    !context?.projectSpaceCapability
  ) {
    entries.push([
      'projectSpaceCapability',
      {
        kind: 'application',
        value: [
          'Use wework_space as the only interface for WeWork project spaces, board items, files, attachments, and deliveries.',
          'Storage and task providers are internal implementation details.',
          'Do not use git commands or call GitHub, GitLab, or object-storage APIs to inspect or modify project-space data.',
          'Use list_spaces to discover spaces, get_board_item for item details, and read_item_attachment for attachment contents.',
        ].join('\n'),
      },
    ])
  }
  if (entries.length === 0) return message
  const contextText = entries.map(([name, entry]) => `[${name}]\n${entry.value}`).join('\n\n')
  return `<application_context>\n${contextText}\n</application_context>\n\n${message}`
}
