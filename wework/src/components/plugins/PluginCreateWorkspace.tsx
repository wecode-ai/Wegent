import { Boxes, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { ChatInput, type ProjectWorkControls } from '@/components/chat/ChatInput'
import { DesktopEmptyTaskLauncher } from '@/components/layout/DesktopEmptyTaskLauncher'
import { WEWORK_PERSONAL_MARKETPLACE_ID } from '@/features/plugins/builtinPlugins'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { focusComposerAtEnd } from '@/lib/workbenchComposerFocus'
import { resolveProjectRuntimeWorkspaceTarget } from '@/lib/workspace-target'
import { track } from '@/telemetry/client'

interface PluginCreateWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
}

export function PluginCreateWorkspace({ topBarLeftActions }: PluginCreateWorkspaceProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const createType =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('type') === 'skill'
      ? 'skill'
      : 'plugin'
  const editPluginName =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('edit')?.trim() || ''
      : ''
  const {
    state,
    workspaceFileApi,
    projectChat,
    projectExecutionMode,
    setProjectExecutionMode,
    projectWorktreeBranch,
    setProjectWorktreeBranch,
    selectProject,
    selectProjectWorkspace,
    selectStandaloneDevice,
    sendCurrentInput,
    startNewChat,
  } = useWorkbench()
  const [prompt, setPrompt] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const workspaceRef = useRef<HTMLElement>(null)

  const projectWork = useMemo<ProjectWorkControls>(
    () => ({
      projects: state.projects,
      devices: state.devices,
      runtimeWork: state.runtimeWork,
      currentProject: state.currentProject,
      currentProjectId: state.currentProject?.id,
      currentStandaloneDeviceId: state.standaloneDeviceId,
      currentRuntimeDeviceId: state.currentRuntimeTask?.deviceId ?? null,
      currentRuntimeTask: state.currentRuntimeTask,
      selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
      pendingProjectWorkspaceProjectId: state.pendingProjectWorkspaceProjectId,
      executionMode: projectExecutionMode,
      executionModeLocked: false,
      onSelectProject: selectProject,
      onSelectStandaloneDevice: selectStandaloneDevice,
      onSelectProjectWorkspace: selectProjectWorkspace,
      onBindProjectWorkspace: selectProject,
      onExecutionModeChange: setProjectExecutionMode,
      worktreeBranch: projectWorktreeBranch,
      onWorktreeBranchChange: setProjectWorktreeBranch,
    }),
    [
      projectExecutionMode,
      projectWorktreeBranch,
      selectProject,
      selectProjectWorkspace,
      selectStandaloneDevice,
      setProjectExecutionMode,
      setProjectWorktreeBranch,
      state.currentProject,
      state.currentRuntimeTask,
      state.devices,
      state.pendingProjectWorkspaceProjectId,
      state.projects,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
    ]
  )
  const workspaceTarget = useMemo(
    () =>
      resolveProjectRuntimeWorkspaceTarget({
        currentProject: state.currentProject,
        runtimeWork: state.runtimeWork,
        selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
      }) ??
      (state.standaloneDeviceId && state.standaloneWorkspacePath
        ? {
            deviceId: state.standaloneDeviceId,
            path: state.standaloneWorkspacePath,
            source: 'runtime' as const,
          }
        : null),
    [
      state.currentProject,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
      state.standaloneWorkspacePath,
    ]
  )

  const dismissPluginCreator = () => {
    setPrompt('')
    setSubmitError(null)
    projectChat.resetAttachments()
    projectChat.setSelectedSkills([])
    startNewChat()
    navigateTo('/')
  }

  useEffect(() => {
    focusComposerAtEnd(
      workspaceRef.current?.querySelector<HTMLElement>('[data-testid="plugin-create-prompt-input"]')
    )
  }, [])

  const submit = async (valueOverride?: string) => {
    const value = (valueOverride ?? prompt).trim()
    if (!value || isSubmitting) return

    setIsSubmitting(true)
    setSubmitError(null)
    const pluginCreatorSkill = {
      name: 'plugin-creator',
      namespace: 'codex',
      is_public: false,
    }
    projectChat.setSelectedSkills([pluginCreatorSkill])
    const message = [
      editPluginName
        ? `Use the Codex plugin-creator workflow to continue editing the existing local plugin "${editPluginName}" in Wegent.`
        : 'Use the Codex plugin-creator workflow to create a local Codex-compatible plugin for Wegent.',
      `Create and install it in the registered managed local marketplace named "${WEWORK_PERSONAL_MARKETPLACE_ID}". Resolve that marketplace's existing local path before creating any files.`,
      'Do not use the Plugin Creator defaults under ~/plugins or ~/.agents. Keep the managed marketplace manifests in sync and verify the plugin is discoverable from that marketplace before reporting success.',
      'Do not upload it or publish it.',
      createType === 'skill'
        ? 'Create a single-Skill plugin: .codex-plugin/plugin.json plus exactly one skills/<slug>/SKILL.md.'
        : 'The plugin must use .codex-plugin/plugin.json.',
      '',
      value,
    ].join('\n')

    try {
      const sent = await sendCurrentInput(message, {
        forceNewTask: true,
        additionalSkills: [pluginCreatorSkill],
        onError: setSubmitError,
      })
      if (sent) {
        track('feature_action_completed', { domain: 'plugin', action: 'create' })
        navigateTo('/')
      } else {
        track('operation_failed', { operation: 'plugin_action' })
      }
    } catch (error) {
      track('operation_failed', { operation: 'plugin_action' })
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main
      ref={workspaceRef}
      data-testid="plugin-create-workspace"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-text-primary"
    >
      {topBarLeftActions ? (
        <div className="pointer-events-none absolute left-4 top-1.5 z-chrome flex items-center gap-1">
          <div className="pointer-events-auto">{topBarLeftActions}</div>
        </div>
      ) : null}

      <DesktopEmptyTaskLauncher
        projectName={state.currentProject?.name}
        onOpenProjectSelector={anchorElement => {
          const projectButton = workspaceRef.current?.querySelector<HTMLButtonElement>(
            '[data-testid="project-work-button"]'
          )
          if (projectButton) {
            projectButton.click()
            return
          }
          anchorElement.blur()
        }}
        onSelectSuggestion={setPrompt}
        composerInputTestId="plugin-create-prompt-input"
        composer={
          <ChatInput
            value={prompt}
            onChange={setPrompt}
            onSubmit={submit}
            disabled={isSubmitting}
            submitDisabled={!prompt.trim() || isSubmitting}
            error={submitError}
            placeholder={t('workbench.input_placeholder', '随心输入')}
            inputTestId="plugin-create-prompt-input"
            submitButtonTestId="plugin-create-submit-button"
            variant={isMobile ? 'compact' : 'desktop'}
            projectChat={projectChat}
            projectWork={projectWork}
            showProjectWorkBar={!isMobile}
            workspaceTarget={workspaceTarget}
            workspaceFileApi={workspaceFileApi}
            inputLeadingContext={
              <span
                data-testid="plugin-creator-context"
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-focus/25 bg-focus/10 px-2 text-sm font-normal text-focus"
              >
                <Boxes className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Plugin Creator</span>
                <button
                  type="button"
                  data-testid="plugin-creator-context-dismiss"
                  aria-label={t('workbench.cancel', '取消')}
                  className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-sm text-focus/80 transition-colors hover:bg-focus/15 hover:text-focus"
                  onClick={dismissPluginCreator}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </span>
            }
            onDismissInputLeadingContext={dismissPluginCreator}
          />
        }
      />
    </main>
  )
}
