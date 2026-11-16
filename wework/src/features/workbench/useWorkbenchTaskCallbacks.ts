import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import type { SkillRef, UnifiedSkill } from '@/types/api'
import type { useWorkbenchAttachments } from './useWorkbenchAttachments'
import { getProjectChatScopeKey } from './workbenchProviderHelpers'
// Keep memoized callbacks in independent scopes so they cannot retain prior provider renders.
import { localSkillReference } from '@/lib/local-skill-reference'
import { navigateTo } from '@/lib/navigation'
import { requestNewChatComposerFocus } from '@/lib/workbenchComposerFocus'
import type {
  LocalDeviceSkill,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeTaskAddress,
  RuntimeTaskIMNotificationSubscriptionRequest,
  User,
} from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import type { ActionDispatch, RefObject } from 'react'
import { useCallback } from 'react'
import type { WorkbenchAction } from './workbenchReducer'
import {
  findSelectableProject,
  getDefaultProjectDeviceWorkspaceId,
  getRememberedStandaloneDeviceId,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import type { WorkbenchServices } from './workbenchServices'
const LOCAL_SKILLS_CACHE_TTL_MS = 30_000
export function useListLocalSkills({
  localSkillsWorkspacePath,
  localSkillsCacheRef,
  localPluginApi,
}: {
  localSkillsWorkspacePath: string | null
  localSkillsCacheRef: RefObject<Map<string, { expiresAt: number; skills: LocalDeviceSkill[] }>>
  localPluginApi: LocalCodexPluginApi
}) {
  return useCallback(
    async (forceReload = false) => {
      const cwds = localSkillsWorkspacePath ? [localSkillsWorkspacePath] : []
      const cacheKey = cwds.length > 0 ? cwds.join('\u0000') : 'default'

      const cached = localSkillsCacheRef.current.get(cacheKey)
      if (!forceReload && cached && cached.expiresAt > Date.now()) {
        return cached.skills
      }

      const skills = await localPluginApi.listSkills({ cwds, forceReload })
      localSkillsCacheRef.current.set(cacheKey, {
        expiresAt: Date.now() + LOCAL_SKILLS_CACHE_TTL_MS,
        skills,
      })
      return skills
    },
    [localPluginApi, localSkillsCacheRef, localSkillsWorkspacePath]
  )
}

export function useStartNewSkillChat({
  availableSkills,
  listLocalSkills,
  state,
  setSelectedSkillsForScope,
  setDraftInputForScope,
  ownershipKey,
  dispatch,
  user,
  workspaceTabId,
}: {
  availableSkills: UnifiedSkill[]
  listLocalSkills: (forceReload?: boolean) => Promise<LocalDeviceSkill[]>
  state: WorkbenchState
  setSelectedSkillsForScope: (targetScopeKey: string, nextSkills: SkillRef[]) => void
  setDraftInputForScope: (scopeKey: string, value: string) => void
  ownershipKey: string
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  user: User
  workspaceTabId: string | undefined
}) {
  return useCallback(
    async (
      skillNames: string[],
      options: { allowLocalSkills?: boolean } = {}
    ): Promise<boolean> => {
      const requestedNames = skillNames.map(name => name.trim()).filter(Boolean)
      if (requestedNames.length === 0) {
        return false
      }

      const requestedUnifiedSkills = requestedNames.map(name =>
        availableSkills.find(
          skill =>
            skill.is_active && (skill.name === name || `${skill.namespace}:${skill.name}` === name)
        )
      )
      const unresolvedNames = requestedNames.filter((_, index) => !requestedUnifiedSkills[index])
      const localSkills =
        options.allowLocalSkills !== false && unresolvedNames.length > 0
          ? await listLocalSkills(true)
          : []
      const requestedLocalSkills = unresolvedNames.map(name =>
        localSkills.find(
          skill =>
            skill.name === name || (!skill.name.includes(':') && name.endsWith(`:${skill.name}`))
        )
      )
      if (requestedLocalSkills.some(skill => !skill)) return false
      const resolvedLocalSkills = requestedLocalSkills.filter((skill): skill is LocalDeviceSkill =>
        Boolean(skill)
      )

      const nextScopeKey = getProjectChatScopeKey({
        currentRuntimeTask: null,
        standaloneChatKey: state.standaloneChatKey + 1,
      })
      setSelectedSkillsForScope(
        nextScopeKey,
        requestedUnifiedSkills.flatMap(skill =>
          skill
            ? [
                {
                  name: skill.name,
                  namespace: skill.namespace,
                  is_public: skill.is_public,
                },
              ]
            : []
        )
      )
      if (resolvedLocalSkills.length > 0) {
        const references = resolvedLocalSkills.map((skill, index) => {
          const requestedName = unresolvedNames[index]
          const namespaceSeparator = requestedName.indexOf(':')
          const mentionName =
            namespaceSeparator > 0 ? requestedName.slice(0, namespaceSeparator) : skill.name
          return localSkillReference(skill, mentionName)
        })
        const input = `${references.join(' ')} `
        setDraftInputForScope(nextScopeKey, input)
      }
      writeLastProjectId(ownershipKey, null)
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
      navigateTo('/')
      requestNewChatComposerFocus(workspaceTabId)
      return true
    },
    [
      listLocalSkills,
      state.standaloneChatKey,
      state.devices,
      state.standaloneDeviceId,
      setSelectedSkillsForScope,
      ownershipKey,
      dispatch,
      user,
      workspaceTabId,
      availableSkills,
      setDraftInputForScope,
    ]
  )
}

export function useStartStandaloneChat({
  ownershipKey,
  dispatch,
  user,
  state,
}: {
  ownershipKey: string
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  user: User
  state: WorkbenchState
}) {
  return useCallback(() => {
    writeLastProjectId(ownershipKey, null)
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
    navigateTo('/')
  }, [ownershipKey, dispatch, user, state.devices, state.standaloneDeviceId])
}

export function useStartNewProjectChat({
  state,
  attachmentSelection,
  draftInputByScope,
  projectSelectionStartedRef,
  ownershipKey,
  dispatch,
  workspaceTabId,
}: {
  state: WorkbenchState
  attachmentSelection: ReturnType<typeof useWorkbenchAttachments>
  draftInputByScope: Record<string, string>
  projectSelectionStartedRef: RefObject<boolean>
  ownershipKey: string
  dispatch: ActionDispatch<[action: WorkbenchAction]>
  workspaceTabId: string | undefined
}) {
  return useCallback(
    (projectId: number) => {
      const deviceWorkspaceId = getDefaultProjectDeviceWorkspaceId(state.runtimeWork, projectId)
      const project = findSelectableProject(state.projects, state.runtimeWork, projectId)
      if (!project) return
      const blankScopeKey = getProjectChatScopeKey({
        currentRuntimeTask: null,
        standaloneChatKey: state.standaloneChatKey,
      })
      const blankAttachmentState = attachmentSelection.stateByScope[blankScopeKey]
      const hasPreservedBlankComposerState =
        Boolean(draftInputByScope[blankScopeKey]) ||
        Boolean(
          blankAttachmentState &&
          (blankAttachmentState.attachments.length > 0 ||
            blankAttachmentState.uploadingFiles.size > 0 ||
            blankAttachmentState.errors.size > 0)
        )
      projectSelectionStartedRef.current = true
      writeLastProjectId(ownershipKey, project.id)
      dispatch({
        type: 'project_workspace_selected',
        project,
        deviceWorkspaceId,
        startFreshChat: Boolean(state.currentRuntimeTask && !hasPreservedBlankComposerState),
      })
      navigateTo('/')
      requestNewChatComposerFocus(workspaceTabId)
    },
    [
      state.runtimeWork,
      state.projects,
      state.standaloneChatKey,
      state.currentRuntimeTask,
      attachmentSelection.stateByScope,
      draftInputByScope,
      projectSelectionStartedRef,
      ownershipKey,
      dispatch,
      workspaceTabId,
    ]
  )
}

export function useListImPrivateSessions({
  resolvedServices,
}: {
  resolvedServices: WorkbenchServices
}) {
  return useCallback(
    () =>
      resolvedServices.imSessionApi?.listPrivateSessions() ??
      Promise.resolve({ total: 0, items: [] }),
    [resolvedServices]
  )
}

export function useGetImNotificationSettings({
  resolvedServices,
}: {
  resolvedServices: WorkbenchServices
}) {
  return useCallback(() => {
    if (!resolvedServices.runtimeWorkApi) {
      return Promise.reject(new Error('Runtime work API is unavailable'))
    }
    return resolvedServices.runtimeWorkApi.getImNotificationSettings()
  }, [resolvedServices])
}

export function useUpdateGlobalImNotification({
  resolvedServices,
}: {
  resolvedServices: WorkbenchServices
}) {
  return useCallback(
    (data: RuntimeGlobalIMNotificationUpdateRequest) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.updateGlobalImNotification(data)
    },
    [resolvedServices]
  )
}

export function useSubscribeRuntimeTaskNotifications({
  resolvedServices,
}: {
  resolvedServices: WorkbenchServices
}) {
  return useCallback(
    (data: RuntimeTaskIMNotificationSubscriptionRequest) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.subscribeRuntimeTaskNotifications(data)
    },
    [resolvedServices]
  )
}

export function useUnsubscribeRuntimeTaskNotifications({
  resolvedServices,
}: {
  resolvedServices: WorkbenchServices
}) {
  return useCallback(
    (address: RuntimeTaskAddress) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.unsubscribeRuntimeTaskNotifications(address)
    },
    [resolvedServices]
  )
}

export function useSetWorkbenchError({
  dispatch,
}: {
  dispatch: ActionDispatch<[action: WorkbenchAction]>
}) {
  return useCallback((error: string | null) => dispatch({ type: 'error_set', error }), [dispatch])
}
