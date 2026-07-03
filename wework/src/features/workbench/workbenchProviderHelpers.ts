import type {
  ModelCompatibilityDisabledReason,
  ModelSelectionConfig,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  UnifiedModel,
  User,
} from '@/types/api'
import type { DeviceUpgradeStatusPayload } from '@/types/device-events'
import { findRuntimeLocalTask } from './workbenchRuntimeHelpers'

const CLAUDE_CODE_RUNTIME_FAMILY = 'claude.claude'
const OPENAI_RESPONSES_RUNTIME_FAMILY = 'openai.openai-responses'

export const DEVICE_STATUS_LABELS: Record<string, string> = {
  online: '在线',
  busy: '忙碌',
  offline: '离线',
}

export const TERMINAL_UPGRADE_STATUSES = new Set(['success', 'error', 'skipped', 'busy'])
export const UPGRADE_STATE_CLEAR_DELAY_MS = 5000
export const UPGRADE_REFRESH_INTERVAL_MS = 3000

export function getBlockedModelSelectionMessage(
  reason: ModelCompatibilityDisabledReason | 'locked',
  model?: UnifiedModel | null
): string {
  const modelLabel = model?.displayName || model?.modelId || model?.name || '该模型'
  if (reason === 'locked') {
    return '当前任务的模型选择已锁定'
  }
  if (reason === 'missing_current_runtime_family') {
    return '当前对话缺少模型运行时信息，不能切换模型'
  }
  if (reason === 'missing_target_runtime_family') {
    return `${modelLabel} 缺少运行时信息，不能用于当前对话`
  }
  if (reason === 'unavailable') {
    return `${modelLabel} 当前不可用`
  }
  return `${modelLabel} 与当前对话的模型协议不兼容，请新建对话后使用该模型`
}

export function isTerminalDeviceUpgradeStatus(status: string): boolean {
  return TERMINAL_UPGRADE_STATUSES.has(status)
}

export function getUpgradeStatusMessage(payload: DeviceUpgradeStatusPayload): string {
  if (payload.message) return payload.message
  if (payload.status === 'success') return '升级完成，正在检查设备版本'
  if (payload.status === 'error') return payload.error ?? '升级失败'
  if (payload.status === 'busy') return '设备正在执行任务，空闲后再升级'
  if (payload.status === 'skipped') return '设备已是最新版本'
  return '设备升级中'
}

export function getNewChatModelSelection(user: User | null): ModelSelectionConfig | null {
  return user?.preferences?.wework_new_chat_model_selection ?? null
}

function getRuntimeCompatibilityFamily(runtime?: string | null): string | null {
  if (runtime === 'codex') return OPENAI_RESPONSES_RUNTIME_FAMILY
  if (runtime === 'claude_code' || runtime === 'claude') return CLAUDE_CODE_RUNTIME_FAMILY
  return null
}

export function getCurrentRuntimeTaskCompatibilityFamily(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null | undefined
): string | null {
  return getRuntimeCompatibilityFamily(findRuntimeLocalTask(runtimeWork, address)?.runtime)
}

export function normalizeGuidanceError(error?: string) {
  if (!error) return '引导发送失败'
  if (error.includes('Chat Shell')) {
    return '当前智能体不支持引导，请编辑后排队发送'
  }
  if (error.includes('Turn not found')) {
    return '当前回复已结束，请编辑后重新发送'
  }
  if (error.includes('Not connected') || error.includes('连接未建立')) {
    return '连接未建立，请稍后重试'
  }
  return error
}
