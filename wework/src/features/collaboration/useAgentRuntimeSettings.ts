import { runnerModelKey } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import type { useAgentRouting } from './useAgentRouting'

export function useAgentRuntimeSettings(routing: ReturnType<typeof useAgentRouting>) {
  const { t } = useTranslation('common')
  const environment = routing.candidates[0]
  const policy = routing.executionPolicy
  const environmentLabel =
    policy?.mode === 'project_pool'
      ? t('workbench.agent_creator_environment_automatic')
      : policy?.mode === 'user_select'
        ? t('workbench.runner_user_select')
        : (environment?.name ??
          (policy?.mode === 'fixed' && policy.environment_id
            ? t('workbench.agent_creator_environment_configured')
            : t('workbench.runner_choose_environment')))
  const modelLabel =
    routing.modelMode === 'user_select'
      ? t('workbench.runner_user_select')
      : (routing.models.find(
          model => routing.model && runnerModelKey(model) === runnerModelKey(routing.model)
        )?.label ??
        routing.model?.cloud_model?.name ??
        routing.model?.model_id ??
        t('workbench.agent_creator_model_placeholder'))
  const error =
    routing.error ||
    (!routing.activated
      ? null
      : !routing.environmentLoading &&
          policy?.mode === 'fixed' &&
          policy.environment_id &&
          !environment
        ? t('workbench.runner_environment_unavailable_hint')
        : !routing.loading &&
            policy &&
            (policy.mode !== 'fixed' || policy.environment_id) &&
            routing.modelMode === 'fixed' &&
            routing.model &&
            !routing.modelAvailable &&
            !(routing.nativeLoading && routing.model.source !== 'cloud')
          ? t('workbench.runner_model_conflict')
          : null)
  return {
    onOpen: routing.activate,
    label: t('workbench.agent_creator_runtime_settings'),
    environment: { label: t('workbench.runner_environment'), value: environmentLabel },
    model: { label: t('workbench.agent_creator_model'), value: modelLabel },
    error,
  }
}
