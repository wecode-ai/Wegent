import type { DingTalkDelegation, PersonalStandInSettings } from '@/api/personalStandIn'
import type { RunnerModelIdentity, WorkspaceStandInSettings } from '@wegent/collaboration'
import { dequal } from 'dequal'

export const DINGTALK_PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'

/** Saving a scope never enables the primary assistant; explicit activation may. */
export function withDingTalkDelegation(
  settings: PersonalStandInSettings,
  delegation: DingTalkDelegation,
  model?: RunnerModelIdentity,
  options?: WorkspaceStandInSettings['modelOptions']
): PersonalStandInSettings {
  const { primary } = settings
  return {
    ...settings,
    primary: {
      prompt: '',
      preferences: '',
      ...primary,
      enabled: delegation.enabled || primary?.enabled === true,
      ...(model
        ? {
            model,
            modelOptions: options ?? (dequal(model, primary?.model) ? primary?.modelOptions : {}),
          }
        : {}),
      dingtalkDelegation: delegation,
    },
  }
}
