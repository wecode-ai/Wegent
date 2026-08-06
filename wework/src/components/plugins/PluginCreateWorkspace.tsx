import { Boxes, Plus } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { ChatInput, type ProjectWorkControls } from '@/components/chat/ChatInput'
import { DESKTOP_TOP_BAR_BUTTON_CLASS, DesktopTopBar } from '@/components/layout/DesktopTopBar'
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

export function PluginCreateWorkspace({
  sidebarCollapsed = false,
  topBarLeftActions,
}: PluginCreateWorkspaceProps) {
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
      data-testid="plugin-create-workspace"
      className="min-w-0 flex-1 overflow-y-auto bg-background text-text-primary"
    >
      <DesktopTopBar
        testId="plugin-create-topbar"
        className={[
          'sticky top-0 z-30 h-12 bg-background/94 pl-20 pr-4 backdrop-blur-xl md:h-[52px] md:pr-7',
          sidebarCollapsed ? 'md:pl-6' : 'md:pl-7',
        ].join(' ')}
        left={
          <>
            {topBarLeftActions}
            <button
              type="button"
              className="rounded-lg px-2 py-1 text-sm font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
              onClick={() => navigateTo('/plugins')}
            >
              {t('workbench.plugins_tab', '插件')}
            </button>
          </>
        }
        right={
          <button
            type="button"
            data-testid="plugin-create-new-button"
            aria-label={t('workbench.plugins_create', '创建')}
            className={DESKTOP_TOP_BAR_BUTTON_CLASS}
            onClick={() => {
              setPrompt('')
              setSubmitError(null)
              projectChat.resetAttachments()
              navigateTo('/plugins/create')
            }}
          >
            <Plus />
          </button>
        }
      />
      <section
        ref={workspaceRef}
        className="flex min-h-[calc(100vh-52px)] min-w-0 flex-col px-6 pb-2 pt-8"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center pb-8">
          <div className="mx-auto flex w-[min(46rem,calc(100%_-_2rem))] min-w-0 flex-col items-center">
            <Boxes className="mb-5 h-9 w-9 text-text-muted/55" aria-hidden="true" />
            <h1 className="mb-9 max-w-full text-center text-xl font-normal leading-9 tracking-normal text-text-primary/95">
              {editPluginName
                ? t('workbench.plugins_edit_prompt_title', '你想怎样修改这个插件？')
                : createType === 'skill'
                  ? t('workbench.plugins_create_skill_prompt_title', '你想创建一个什么技能？')
                  : t('workbench.plugins_create_prompt_title', '我们应该在 Wegent 中构建什么？')}
            </h1>
          </div>
        </div>

        <div className="mx-auto w-[min(46rem,calc(100%_-_2rem))] min-w-0 shrink-0">
          <ChatInput
            value={prompt}
            onChange={setPrompt}
            onSubmit={submit}
            disabled={isSubmitting}
            submitDisabled={!prompt.trim() || isSubmitting}
            error={submitError}
            placeholder={
              editPluginName
                ? t('workbench.plugins_edit_prompt_placeholder', '描述要修改或新增的能力')
                : createType === 'skill'
                  ? t('workbench.plugins_create_skill_prompt_placeholder', '描述技能要完成的工作')
                  : t('workbench.plugins_create_prompt_placeholder', '描述你想创建的插件')
            }
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
                className="inline-flex shrink-0 items-center gap-1 text-sm font-normal text-focus"
              >
                <Boxes className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Plugin Creator</span>
              </span>
            }
          />
        </div>
      </section>
    </main>
  )
}
