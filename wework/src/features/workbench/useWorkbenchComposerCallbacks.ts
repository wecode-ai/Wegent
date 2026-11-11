import { findFirstSelectableProject, getProjectChatScopeKey } from './workbenchProviderHelpers'
// Keep memoized callbacks in independent scopes so they cannot retain prior provider renders.
import {
  consumePluginTrial,
  dismissTrialGuide,
  FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT,
  shouldShowPluginTrialGuide,
} from '@/features/plugins/pluginTrial'
import { navigateTo } from '@/lib/navigation'
import type { LocalDeviceApp, PluginPathComponent, User } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import { createPluginTrialGuide } from '@wegent/chat-core/composer-plugin-trial'
import type { ActionDispatch, Dispatch, SetStateAction } from 'react'
import { useCallback } from 'react'
import type { WorkbenchAction } from './workbenchReducer'
import {
  getDefaultProjectDeviceWorkspaceId,
  getRememberedStandaloneDeviceId,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
export function useShowTrialGuide({
  setTrialPluginNameByScope,
  projectChatScopeKey,
  setTrialTemplatesByScope,
  setTrialPluginAppByScope,
}: {
  setTrialPluginNameByScope: Dispatch<SetStateAction<Record<string, string>>>
  projectChatScopeKey: string
  setTrialTemplatesByScope: Dispatch<SetStateAction<Record<string, PluginPathComponent[]>>>
  setTrialPluginAppByScope: Dispatch<SetStateAction<Record<string, LocalDeviceApp>>>
}) {
  return useCallback(
    (title: string, app: LocalDeviceApp) => {
      const guide = createPluginTrialGuide(title, app.trialTemplates, app)
      if (!guide) return
      setTrialPluginNameByScope(current => ({
        ...current,
        [projectChatScopeKey]: guide.pluginName,
      }))
      setTrialTemplatesByScope(current => ({ ...current, [projectChatScopeKey]: guide.templates }))
      setTrialPluginAppByScope(current => ({ ...current, [projectChatScopeKey]: app }))
    },
    [
      projectChatScopeKey,
      setTrialPluginAppByScope,
      setTrialPluginNameByScope,
      setTrialTemplatesByScope,
    ]
  )
}

export function useSetDraftInputForScope({
  writeDraftInputForScope,
  setTrialTemplatesByScope,
  setTrialPluginNameByScope,
  setTrialPluginAppByScope,
}: {
  writeDraftInputForScope: (scopeKey: string, value: string) => void
  setTrialTemplatesByScope: Dispatch<SetStateAction<Record<string, PluginPathComponent[]>>>
  setTrialPluginNameByScope: Dispatch<SetStateAction<Record<string, string>>>
  setTrialPluginAppByScope: Dispatch<SetStateAction<Record<string, LocalDeviceApp>>>
}) {
  return useCallback(
    (scopeKey: string, value: string) => {
      writeDraftInputForScope(scopeKey, value)
      if (!value.trim()) {
        setTrialTemplatesByScope(current => {
          if (!current[scopeKey]) return current
          const next = { ...current }
          delete next[scopeKey]
          return next
        })
        setTrialPluginNameByScope(current => {
          if (!current[scopeKey]) return current
          const next = { ...current }
          delete next[scopeKey]
          return next
        })
        setTrialPluginAppByScope(current => {
          if (!current[scopeKey]) return current
          const next = { ...current }
          delete next[scopeKey]
          return next
        })
      }
    },
    [
      setTrialPluginAppByScope,
      setTrialPluginNameByScope,
      setTrialTemplatesByScope,
      writeDraftInputForScope,
    ]
  )
}

export function useSetDraftInput({
  setDraftInputForScope,
  projectChatScopeKey,
}: {
  setDraftInputForScope: (scopeKey: string, value: string) => void
  projectChatScopeKey: string
}) {
  return useCallback(
    (value: string) => {
      setDraftInputForScope(projectChatScopeKey, value)
    },
    [projectChatScopeKey, setDraftInputForScope]
  )
}

export function useSetComposerErrorForScope({
  setComposerErrorByScope,
}: {
  setComposerErrorByScope: Dispatch<SetStateAction<Record<string, string>>>
}) {
  return useCallback(
    (scopeKey: string, error: string | null) => {
      setComposerErrorByScope(current => {
        if (error) {
          if (current[scopeKey] === error) return current
          return { ...current, [scopeKey]: error }
        }
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
    },
    [setComposerErrorByScope]
  )
}

export function useSetComposerError({
  setComposerErrorForScope,
  projectChatScopeKey,
}: {
  setComposerErrorForScope: (scopeKey: string, error: string | null) => void
  projectChatScopeKey: string
}) {
  return useCallback(
    (error: string | null) => setComposerErrorForScope(projectChatScopeKey, error),
    [projectChatScopeKey, setComposerErrorForScope]
  )
}

export function useDismissTrialGuideForScope({
  trialPluginName,
  projectChatScopeKey,
  setTrialTemplatesByScope,
  setTrialPluginNameByScope,
  setTrialPluginAppByScope,
}: {
  trialPluginName: string
  projectChatScopeKey: string
  setTrialTemplatesByScope: Dispatch<SetStateAction<Record<string, PluginPathComponent[]>>>
  setTrialPluginNameByScope: Dispatch<SetStateAction<Record<string, string>>>
  setTrialPluginAppByScope: Dispatch<SetStateAction<Record<string, LocalDeviceApp>>>
}) {
  return useCallback(() => {
    if (trialPluginName.trim()) {
      dismissTrialGuide(trialPluginName, projectChatScopeKey)
    }
    setTrialTemplatesByScope(current => {
      if (!current[projectChatScopeKey]) return current
      const next = { ...current }
      delete next[projectChatScopeKey]
      return next
    })
    setTrialPluginNameByScope(current => {
      if (!current[projectChatScopeKey]) return current
      const next = { ...current }
      delete next[projectChatScopeKey]
      return next
    })
    setTrialPluginAppByScope(current => {
      if (!current[projectChatScopeKey]) return current
      const next = { ...current }
      delete next[projectChatScopeKey]
      return next
    })
  }, [
    projectChatScopeKey,
    setTrialPluginAppByScope,
    setTrialPluginNameByScope,
    setTrialTemplatesByScope,
    trialPluginName,
  ])
}

export function useApplyQueuedPluginTrial({
  setDraftInputForScope,
  setTrialPluginNameByScope,
  setTrialTemplatesByScope,
  setTrialPluginAppByScope,
}: {
  setDraftInputForScope: (scopeKey: string, value: string) => void
  setTrialPluginNameByScope: Dispatch<SetStateAction<Record<string, string>>>
  setTrialTemplatesByScope: Dispatch<SetStateAction<Record<string, PluginPathComponent[]>>>
  setTrialPluginAppByScope: Dispatch<SetStateAction<Record<string, LocalDeviceApp>>>
}) {
  return useCallback(
    (scopeKey: string, trial: NonNullable<ReturnType<typeof consumePluginTrial>>) => {
      setDraftInputForScope(scopeKey, trial.input)
      const showGuide =
        trial.pluginName.trim().length > 0 &&
        shouldShowPluginTrialGuide(trial.pluginName, scopeKey) &&
        trial.templates.length > 0
      if (showGuide) {
        setTrialPluginNameByScope(current => ({ ...current, [scopeKey]: trial.pluginName }))
        setTrialTemplatesByScope(current => ({
          ...current,
          [scopeKey]: trial.templates.slice(0, 6),
        }))
        const app = trial.app
        if (app) setTrialPluginAppByScope(current => ({ ...current, [scopeKey]: app }))
        else {
          setTrialPluginAppByScope(current => {
            if (!current[scopeKey]) return current
            const next = { ...current }
            delete next[scopeKey]
            return next
          })
        }
        return
      }
      setTrialPluginNameByScope(current => {
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
      setTrialTemplatesByScope(current => {
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
      setTrialPluginAppByScope(current => {
        if (!current[scopeKey]) return current
        const next = { ...current }
        delete next[scopeKey]
        return next
      })
    },
    [
      setDraftInputForScope,
      setTrialPluginAppByScope,
      setTrialPluginNameByScope,
      setTrialTemplatesByScope,
    ]
  )
}

export function useApplyQueuedPluginTrialToFreshChat({
  state,
  ownershipKey,
  dispatch,
  user,
  applyQueuedPluginTrial,
}: {
  state: WorkbenchState
  ownershipKey: string
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  user: User
  applyQueuedPluginTrial: (
    scopeKey: string,
    trial: NonNullable<ReturnType<typeof consumePluginTrial>>
  ) => void
}) {
  return useCallback(
    (trial: NonNullable<ReturnType<typeof consumePluginTrial>>) => {
      const nextStandaloneChatKey = state.standaloneChatKey + 1
      const nextScopeKey = getProjectChatScopeKey({
        currentRuntimeTask: null,
        standaloneChatKey: nextStandaloneChatKey,
      })
      const project = trial.targetWorkspace
        ? null
        : (trial.targetProject ??
          (state.currentProject
            ? findFirstSelectableProject(state.projects, state.runtimeWork, [
                state.currentProject.id,
              ])
            : null))

      if (project) {
        writeLastProjectId(ownershipKey, project.id)
        dispatch({
          type: 'project_workspace_selected',
          project,
          deviceWorkspaceId: getDefaultProjectDeviceWorkspaceId(state.runtimeWork, project.id),
          startFreshChat: true,
        })
      } else {
        writeLastProjectId(ownershipKey, null)
        dispatch({
          type: 'project_cleared',
          standaloneDeviceId:
            trial.targetWorkspace?.deviceId ??
            getRememberedStandaloneDeviceId(user, state.devices, state.standaloneDeviceId),
          standaloneWorkspacePath: trial.targetWorkspace?.path ?? null,
          startFreshChat: true,
        })
      }

      applyQueuedPluginTrial(nextScopeKey, trial)
      navigateTo('/')
      window.dispatchEvent(
        new CustomEvent(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, {
          detail: { expectedValue: trial.input },
        })
      )
    },
    [
      state.standaloneChatKey,
      state.currentProject,
      state.projects,
      state.runtimeWork,
      state.devices,
      state.standaloneDeviceId,
      applyQueuedPluginTrial,
      ownershipKey,
      dispatch,
      user,
    ]
  )
}

export function useConsumeQueuedPluginTrial({
  applyQueuedPluginTrialToFreshChat,
  state,
  applyQueuedPluginTrial,
  dispatch,
  user,
}: {
  applyQueuedPluginTrialToFreshChat: (
    trial: NonNullable<ReturnType<typeof consumePluginTrial>>
  ) => void
  state: WorkbenchState
  applyQueuedPluginTrial: (
    scopeKey: string,
    trial: NonNullable<ReturnType<typeof consumePluginTrial>>
  ) => void
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  user: User
}) {
  return useCallback(() => {
    const trial = consumePluginTrial()
    if (!trial) return
    if (trial.openInNewChat) {
      applyQueuedPluginTrialToFreshChat(trial)
      return
    }
    if (state.currentRuntimeTask) {
      const currentScopeKey = getProjectChatScopeKey({
        currentRuntimeTask: state.currentRuntimeTask,
        standaloneChatKey: state.standaloneChatKey,
      })
      applyQueuedPluginTrial(currentScopeKey, trial)
      navigateTo('/')
      window.dispatchEvent(
        new CustomEvent(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, {
          detail: { expectedValue: trial.input },
        })
      )
      return
    }

    const nextStandaloneChatKey = state.standaloneChatKey + 1
    const nextScopeKey = getProjectChatScopeKey({
      currentRuntimeTask: null,
      standaloneChatKey: nextStandaloneChatKey,
    })
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
      standaloneWorkspacePath: null,
      startFreshChat: true,
    })
    applyQueuedPluginTrial(nextScopeKey, trial)
    navigateTo('/')
    window.dispatchEvent(
      new CustomEvent(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, {
        detail: { expectedValue: trial.input },
      })
    )
  }, [
    applyQueuedPluginTrial,
    applyQueuedPluginTrialToFreshChat,
    dispatch,
    state.currentRuntimeTask,
    state.devices,
    state.standaloneChatKey,
    state.standaloneDeviceId,
    user,
  ])
}
