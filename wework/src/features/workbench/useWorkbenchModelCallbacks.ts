import type { TFunction } from 'i18next'
import type { ProjectWorkPreferenceScope } from './projectWorkPreferences'
// Keep memoized callbacks in independent scopes so they cannot retain prior provider renders.
import type {
  ModelCompatibilityDisabledReason,
  ModelSelectionConfig,
  ProjectExecutionMode,
  UnifiedModel,
  UserPreferences,
} from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import type { ActionDispatch, Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback } from 'react'
import { mergeProjectWorkPreference } from './projectWorkPreferences'
import { getBlockedModelSelectionMessage } from './workbenchProviderHelpers'
import type { WorkbenchAction } from './workbenchReducer'
import type { WorkbenchServices } from './workbenchServices'
export function usePersistProjectWorkPreference({
  projectWorkPreferenceScope,
  projectWorkPreferenceKey,
  latestUserPreferencesRef,
  dispatch,
  resolvedServices,
  projectWorkPreferenceMutationQueueRef,
  activeProjectWorkPreferenceKeyRef,
}: {
  projectWorkPreferenceScope: ProjectWorkPreferenceScope | null
  projectWorkPreferenceKey: string | null
  latestUserPreferencesRef: RefObject<UserPreferences | null | undefined>
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  resolvedServices: WorkbenchServices
  projectWorkPreferenceMutationQueueRef: RefObject<Promise<void>>
  activeProjectWorkPreferenceKeyRef: RefObject<string | null>
}) {
  return useCallback(
    (
      patch: {
        executionMode?: ProjectExecutionMode
        worktreeBranch?: string | null
      },
      errorMessage: string
    ) => {
      if (!projectWorkPreferenceScope || !projectWorkPreferenceKey) return

      const preferences = mergeProjectWorkPreference(
        latestUserPreferencesRef.current,
        projectWorkPreferenceScope,
        patch
      )
      if (!preferences) return

      latestUserPreferencesRef.current = preferences
      dispatch({ type: 'user_preferences_updated', preferences })

      const userApi = resolvedServices.userApi
      if (!userApi) return
      const scopeKey = projectWorkPreferenceKey
      const mutation = () =>
        userApi
          .updateCurrentUser({
            preferences: {
              wework_project_work_preferences: preferences.wework_project_work_preferences,
            },
          })
          .then(() => undefined)
      const run = projectWorkPreferenceMutationQueueRef.current
        .catch(() => undefined)
        .then(mutation)
      projectWorkPreferenceMutationQueueRef.current = run.then(
        () => undefined,
        () => undefined
      )
      void run.catch(() => {
        if (activeProjectWorkPreferenceKeyRef.current === scopeKey) {
          dispatch({ type: 'error_set', error: errorMessage })
        }
      })
    },
    [
      activeProjectWorkPreferenceKeyRef,
      dispatch,
      latestUserPreferencesRef,
      projectWorkPreferenceKey,
      projectWorkPreferenceMutationQueueRef,
      projectWorkPreferenceScope,
      resolvedServices.userApi,
    ]
  )
}

export function useSelectProjectExecutionMode({
  state,
  setProjectExecutionMode,
  persistProjectWorkPreference,
  projectWorktreeBranch,
  t,
}: {
  state: WorkbenchState
  setProjectExecutionMode: Dispatch<SetStateAction<string>>
  persistProjectWorkPreference: (
    patch: { executionMode?: ProjectExecutionMode; worktreeBranch?: string | null },
    errorMessage: string
  ) => void
  projectWorktreeBranch: string | null
  t: TFunction<'common', undefined>
}) {
  return useCallback(
    (mode: ProjectExecutionMode) => {
      if (state.currentRuntimeTask) return
      const nextMode: ProjectExecutionMode =
        mode === 'git_worktree' ? 'git_worktree' : 'current_workspace'
      setProjectExecutionMode(nextMode)
      persistProjectWorkPreference(
        {
          executionMode: nextMode,
          worktreeBranch: projectWorktreeBranch,
        },
        t('workbench.execution_mode_save_failed')
      )
    },
    [
      persistProjectWorkPreference,
      projectWorktreeBranch,
      setProjectExecutionMode,
      state.currentRuntimeTask,
      t,
    ]
  )
}

export function useSetProjectWorktreeBranch({
  state,
  setProjectWorktreeBranchState,
  persistProjectWorkPreference,
  projectExecutionMode,
  t,
}: {
  state: WorkbenchState
  setProjectWorktreeBranchState: Dispatch<SetStateAction<string | null>>
  persistProjectWorkPreference: (
    patch: { executionMode?: ProjectExecutionMode; worktreeBranch?: string | null },
    errorMessage: string
  ) => void
  projectExecutionMode: string
  t: TFunction<'common', undefined>
}) {
  return useCallback(
    (branchName: string | null) => {
      if (state.currentRuntimeTask) return
      const normalizedBranch = branchName?.trim() || null
      setProjectWorktreeBranchState(normalizedBranch)
      persistProjectWorkPreference(
        {
          executionMode: projectExecutionMode,
          worktreeBranch: normalizedBranch,
        },
        t('workbench.project_worktree_branch_save_failed')
      )
    },
    [
      persistProjectWorkPreference,
      projectExecutionMode,
      setProjectWorktreeBranchState,
      state.currentRuntimeTask,
      t,
    ]
  )
}

export function usePersistNewChatModelSelection({
  latestUserPreferencesRef,
  dispatch,
  resolvedServices,
  modelSelectionMutationQueueRef,
}: {
  latestUserPreferencesRef: RefObject<UserPreferences | null | undefined>
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  resolvedServices: WorkbenchServices
  modelSelectionMutationQueueRef: RefObject<Promise<void>>
}) {
  return useCallback(
    (selection: ModelSelectionConfig) => {
      const preferences = {
        ...(latestUserPreferencesRef.current ?? {}),
        wework_new_chat_model_selection: selection,
      }
      latestUserPreferencesRef.current = preferences
      dispatch({ type: 'user_preferences_updated', preferences })

      const userApi = resolvedServices.userApi
      if (!userApi) return
      const mutation = () =>
        userApi
          .updateCurrentUser({
            preferences: { wework_new_chat_model_selection: selection },
          })
          .then(() => undefined)
      const run = modelSelectionMutationQueueRef.current.catch(() => undefined).then(mutation)
      modelSelectionMutationQueueRef.current = run.then(
        () => undefined,
        () => undefined
      )
      void run.catch(() => {
        dispatch({ type: 'error_set', error: '模型配置保存失败' })
      })
    },
    [dispatch, latestUserPreferencesRef, modelSelectionMutationQueueRef, resolvedServices.userApi]
  )
}

export function useHandleBlockedModelSelection({
  dispatch,
}: {
  dispatch: ActionDispatch<[action: WorkbenchAction]>
}) {
  return useCallback(
    (reason: ModelCompatibilityDisabledReason | 'locked', model?: UnifiedModel | null) => {
      dispatch({
        type: 'error_set',
        error: getBlockedModelSelectionMessage(reason, model),
      })
    },
    [dispatch]
  )
}

export function useHandleBlockedModelSelect({
  dispatch,
}: {
  dispatch: ActionDispatch<[action: WorkbenchAction]>
}) {
  return useCallback(
    (model: UnifiedModel, message?: string) => {
      dispatch({
        type: 'error_set',
        error: message || getBlockedModelSelectionMessage('runtime_family_mismatch', model),
      })
    },
    [dispatch]
  )
}

export function useRequestTaskComposerCatalogs({
  setTaskComposerCatalogsRequested,
}: {
  setTaskComposerCatalogsRequested: Dispatch<SetStateAction<boolean>>
}) {
  return useCallback(() => {
    setTaskComposerCatalogsRequested(true)
  }, [setTaskComposerCatalogsRequested])
}

export function useHandleModelSelectorOpenChange({ refreshModels }: { refreshModels: () => void }) {
  return useCallback(
    (open: boolean) => {
      if (open) refreshModels()
    },
    [refreshModels]
  )
}
