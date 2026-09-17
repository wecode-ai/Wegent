import { PluginTrialTemplateStrip } from '../composer/PluginTrialTemplateStrip'
import { ComposerPluginIcon } from '../composer/ComposerPluginIcon'
import {
  createPluginTrialGuide,
  buildTrialTemplatePrompt,
} from '@wegent/chat-core/composer-plugin-trial'
import {
  compareComposerPluginsByUsage,
  sortComposerPluginsByUsage,
  readRecentPluginAppIds,
  RECENT_PLUGIN_APPS_KEY,
} from '../composer/composerPluginSort'
import { recordPluginUsageFromInput } from '../composer/pluginUsage'
import { createRuntimeComposerPluginSource } from '@wegent/chat-core/runtime-composer-plugin-source'
import type { LocalDeviceApp } from '@wegent/chat-core/runtime-composer-catalog'
import { createPluginAssetResolver } from '@wegent/chat-core/plugin-assets'
import { createComposerCatalogStore } from '../composer/createComposerCatalogStore'
import { PluginPickerMenu } from '../composer/PluginPickerMenu'
import { appReference, displayAppName } from '../composer/composerMentionCandidates'
import { registerComposerMentionIcon } from '../composer/composerMentions'
import { useCollaborationPortalTheme, useDocumentTheme } from '../theme'
import { createComposerPluginAssetReader } from '../composer/pluginAssetReader'
import type { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
import type { RuntimePaneQueuedMessage } from '@wegent/chat-core/conversation-queue'
import { ConversationQueuePanel } from '../conversation/ConversationQueuePanel'
import { persistAttachmentReferences } from '../composer/attachmentFiles'
import { useBrowserTaskConversationQueue } from './useBrowserTaskConversationQueue'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useBrowserTaskDraft } from './browserTaskDraftContext'
import type { UnifiedModel } from '@wegent/chat-core/models'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { RuntimeTaskSummary } from '@wegent/chat-core/runtime-task-api-types'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationTranslate } from '../i18n'
import type { AttachmentImageServices } from './AttachmentImageView'
import type { Attachment } from '@wegent/chat-core/runtime'
import { ComposerAttachmentBadges } from './ComposerAttachmentBadges'
import { ModelSelector } from '../controls/ModelSelector'
import {
  findModelForSelection,
  modelSelectionFromRuntimeHandle,
} from '@wegent/chat-core/runtime-model-selection'
import { runtimeContinuationRequest } from '../execution/runtimeContinuationRequest'
import {
  ProjectComposerBody,
  ComposerErrorBanner,
  type ComposerInputHandle,
  ComposerToolbar,
  type ComposerSubmitOptions,
} from '../composer'
import { ComposerAutocompleteInput } from '../composer/ComposerAutocompleteInput'
import { ContextUsageIndicator } from '../composer/ContextUsageIndicator'
import { BrowserQuickPhraseMenu } from './BrowserQuickPhraseMenu'
import { applyQuickPhrase } from '../composer/applyQuickPhrase'

const pluginAssets = createPluginAssetResolver(path => path)

/** Browser runtime effects around the PC composer; the surface and controls are shared. */
export function BrowserTaskComposer({
  runtime,
  session,
  address,
  task,
  projectId,
  running,
  imageServices,
  translate: t,
  onAccepted,
  collapseWhenIdle = false,
}: {
  runtime: SharedWorkspaceRuntimeApi
  session: ReturnType<typeof createRuntimeConversationSession>
  address: RuntimeTaskAddress
  task: RuntimeTaskSummary | null
  projectId: string
  running: boolean
  imageServices: AttachmentImageServices<Attachment>
  translate: CollaborationTranslate
  collapseWhenIdle?: boolean
  onAccepted(): Promise<void>
}) {
  const {
    draft,
    setDraft,
    pluginTrial,
    setPluginTrial,
    selection,
    setSelection,
    attachments,
    busy,
    error,
    setError,
    beginOperation,
    endOperation,
  } = useBrowserTaskDraft(`${address.deviceId}:${address.taskId}`)
  const queue = useBrowserTaskConversationQueue({
    runtime,
    address,
    task,
    session,
    projectId,
    running,
    sending: busy,
    translate: t,
  })
  const [catalog, setCatalog] = useState<UnifiedModel[] | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const composerRef = useRef<ComposerInputHandle>(null)
  const conversation = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  )
  const pluginCatalog = useMemo(() => {
    if (!runtime.composer) return null
    return {
      store: createComposerCatalogStore<LocalDeviceApp>(),
      source: createRuntimeComposerPluginSource(
        runtime.composer.readCatalog,
        { deviceId: address.deviceId, taskId: address.taskId },
        t,
        createComposerPluginAssetReader(runtime.readWorkspaceFile, address.deviceId)
      ),
    }
  }, [runtime.composer, runtime.readWorkspaceFile, address.deviceId, address.taskId, t])
  const portalTheme = useCollaborationPortalTheme()
  const documentTheme = useDocumentTheme()
  const appearanceMode = portalTheme['data-theme'] ?? documentTheme
  const resolveAppLogo = useCallback(
    (app: LocalDeviceApp) =>
      pluginAssets.resolvePluginLogo({
        logo: app.logoUrl,
        logoDark: app.logoUrlDark,
        appearanceMode,
      }),
    [appearanceMode]
  )
  const [isMobile, setMobile] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const change = () => setMobile(media.matches)
    change()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    let active = true
    void runtime
      .listModels(address.deviceId)
      .then(models => {
        if (active) {
          setCatalog(models)
          setCatalogError(null)
        }
      })
      .catch(cause => {
        if (active) setCatalogError(String(cause instanceof Error ? cause.message : cause))
      })
    return () => {
      active = false
    }
  }, [runtime, address.deviceId, catalogRevision])
  const persistedSelection =
    task?.modelSelection ?? modelSelectionFromRuntimeHandle(task?.runtimeHandle)
  const activeModel = findModelForSelection(catalog ?? [], persistedSelection)
  const selectedModel = selection ? selection.model : activeModel
  const options = selection?.options ?? persistedSelection?.options ?? {}
  function selectOption(id: string, value: string) {
    setSelection({ model: selectedModel, options: { ...options, [id]: value } })
  }
  async function submit(submitOptions?: ComposerSubmitOptions, value = draft) {
    if (busy || !task || !attachments.isAttachmentReadyToSend || !value.trim() || !beginOperation())
      return
    let queuedMessage: RuntimePaneQueuedMessage | undefined
    try {
      const request = runtimeContinuationRequest(address, task, selection, projectId)
      if (selection && !request.modelId && Object.keys(options).length)
        throw new Error(t('activity.task_conversation_model_required'))
      const payload = {
        ...request,
        message: value.trim(),
        clientUserMessageId: crypto.randomUUID(),
        attachmentIds: attachments.attachments.map(attachment => attachment.id),
        attachments: attachments.attachments,
        cloudProjectId: projectId,
      }
      queuedMessage = {
        id: payload.clientUserMessageId,
        content: payload.message,
        status: 'queued',
        createdAt: new Date().toISOString(),
        attachments: persistAttachmentReferences(attachments.attachments),
        modelId: payload.modelId,
        modelType: payload.modelType,
        modelOptions: payload.modelOptions,
      }
      if (running && !submitOptions?.interruptWhenBusy) {
        queue.queue.enqueue(queuedMessage)
        recordPluginUsageFromInput(value)
        setDraft('')
        attachments.resetAttachments()
        if (submitOptions?.guideWhenBusy) await queue.guide(queuedMessage.id)
        return
      }
      {
        const result = await (running && submitOptions?.interruptWhenBusy
          ? runtime.work.interruptAndSendRuntimeMessage(payload)
          : runtime.work.sendRuntimeMessage(payload))
        if (!result.accepted) {
          if (!queue.isBusyError(result.error ?? null))
            throw new Error(result.error || t('todo.send_failed'))
          queue.queue.enqueue(queuedMessage, { value: queue.lifecycle() })
        }
      }
      recordPluginUsageFromInput(value)
      setDraft('')
      attachments.resetAttachments()
      // Sending succeeded even if refreshing history fails; the session exposes that failure.
      await onAccepted()
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      if (queuedMessage && queue.isBusyError(error)) {
        queue.queue.enqueue(queuedMessage, { value: queue.lifecycle() })
        setDraft('')
        attachments.resetAttachments()
        await onAccepted()
      } else {
        setError(error)
      }
    } finally {
      endOperation()
    }
  }
  async function pause() {
    if (!beginOperation()) return
    try {
      await runtime.cancel(address)
      await onAccepted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      endOperation()
    }
  }
  return (
    <>
      <ConversationQueuePanel
        translate={t}
        queuedMessages={queue.messages}
        guidanceMessages={[]}
        onCancelQueuedMessage={id => queue.queue.cancel(id)}
        onSendQueuedAsGuidance={id => {
          void queue.guide(id, true)
        }}
        onEditQueuedMessage={id => {
          const message = queue.queue.take(id)
          if (!message) return
          setDraft(message.content)
          attachments.resetAttachments()
          message.attachments?.forEach(attachments.addExistingAttachment)
          composerRef.current?.focus()
        }}
      />
      <ComposerErrorBanner
        error={error || catalogError}
        action={
          catalogError ? (
            <button
              type="button"
              data-testid="task-conversation-models-retry"
              onClick={() => setCatalogRevision(value => value + 1)}
              className="ml-2 underline"
            >
              {t('activity.retry')}
            </button>
          ) : undefined
        }
      />
      {pluginTrial && (
        <PluginTrialTemplateStrip
          key={pluginTrial.pluginName}
          translate={t}
          templates={pluginTrial.templates}
          pluginName={pluginTrial.pluginName}
          pluginApp={pluginTrial.app}
          draft={draft}
          hasConversationContext
          renderPluginIcon={(app, props) => (
            <ComposerPluginIcon {...props} name={app.name} logo={resolveAppLogo(app)} />
          )}
          onApplyTemplate={template => {
            const editor = composerRef.current
            if (!editor) return
            const next = buildTrialTemplatePrompt(
              editor.getValue(),
              template,
              pluginTrial.pluginName
            )
            editor.setValue(next)
            setDraft(next)
            editor.focus()
          }}
          onDismiss={() => {
            setPluginTrial(null)
            composerRef.current?.focus()
          }}
        />
      )}
      <ProjectComposerBody
        ref={composerRef}
        translate={t}
        value={draft}
        onChange={value => {
          setDraft(value)
          setError(null)
        }}
        onSubmit={(value, options) => void submit(options, value)}
        disabled={busy || !task}
        submitDisabled={!attachments.isAttachmentReadyToSend}
        requireText
        isModelSelectionReady={catalog !== null || catalogError !== null}
        placeholder={t('activity.task_conversation_placeholder')}
        inputTestId="chat-input"
        attachments={attachments.attachments}
        uploadingCount={attachments.uploadingFiles.size}
        attachmentErrorCount={attachments.errors.size}
        planModeActive={options.collaborationMode === 'plan'}
        collapseWhenIdle={collapseWhenIdle}
        isStreaming={running}
        onFileSelect={files => attachments.handleFileSelect(files)}
        onRemoveAttachment={id => {
          void attachments.removeAttachment(id).catch(cause => setError(String(cause)))
        }}
        renderAttachments={onShowTextAttachment => (
          <ComposerAttachmentBadges
            {...attachments}
            onShowTextAttachment={onShowTextAttachment}
            onRemoveAttachment={id => {
              void attachments.removeAttachment(id).catch(cause => setError(String(cause)))
            }}
            imageServices={imageServices}
            labels={{
              showText: t('workbench.show_text_attachment_in_composer'),
              appshot: t('workbench.appshot_attachment_label'),
            }}
          />
        )}
        renderEditor={props => (
          <ComposerAutocompleteInput
            key={`${address.deviceId}:${address.taskId}`}
            {...props}
            translate={t}
            onSubmit={(value, options) => props.onSubmit(value ?? draft, options)}
            workspaceTarget={
              task?.workspacePath ? { deviceId: address.deviceId, path: task.workspacePath } : null
            }
            workspaceFileApi={runtime.composer}
            onListLocalSkills={pluginCatalog?.source.listSkills}
            onListLocalApps={pluginCatalog?.source.listApps}
            onSelectApp={(title, app) =>
              setPluginTrial(createPluginTrialGuide(title, app.trialTemplates, app))
            }
            appsStore={pluginCatalog?.store}
            resolveAppLogo={resolveAppLogo}
            compareApps={compareComposerPluginsByUsage}
            models={catalog ?? []}
            selectedModel={selectedModel}
            selectedModelOptions={options}
            onSelectModel={model => setSelection({ model, options })}
            onBlockedModelSelect={(_, message) => setError(message ?? t('todo.send_failed'))}
            isModelSelectionReady={catalog !== null || catalogError !== null}
            planModeActive={options.collaborationMode === 'plan'}
            onSetPlanMode={() => selectOption('collaborationMode', 'plan')}
          />
        )}
        renderToolbar={toolbarProps => (
          <ComposerToolbar
            translate={t}
            renderFeatureMenus={() => (
              <>
                {runtime.quickPhrases ? (
                  <BrowserQuickPhraseMenu
                    store={runtime.quickPhrases}
                    translate={t}
                    disabled={busy || !task}
                    onSelect={phrase => {
                      if (!composerRef.current || !task) return
                      applyQuickPhrase(phrase, composerRef.current, {
                        clearPlan: () => selectOption('collaborationMode', 'default'),
                        setPlan: () => selectOption('collaborationMode', 'plan'),
                      })
                      if (phrase.attachmentPaths?.length) {
                        void Promise.all(
                          phrase.attachmentPaths.map(async path => {
                            const blob = await runtime.readWorkspaceFile({
                              device_id: address.deviceId,
                              workspace_path: task.workspacePath,
                              path,
                            })
                            return new File([blob], path.split(/[\\/]/).pop() || path, {
                              type: blob.type,
                            })
                          })
                        )
                          .then(files => attachments.handleFileSelect(files))
                          .catch(cause => {
                            setError(cause instanceof Error ? cause.message : String(cause))
                          })
                      }
                    }}
                  />
                ) : null}
                {pluginCatalog && (
                  <PluginPickerMenu
                    key={`plugins:${address.deviceId}:${address.taskId}`}
                    translate={t}
                    iconOnly
                    disabled={busy || !task}
                    appsStore={pluginCatalog.store}
                    onListLocalApps={pluginCatalog.source.listApps}
                    resolveAppLogo={resolveAppLogo}
                    sortApps={sortComposerPluginsByUsage}
                    onSelect={app => {
                      const input = composerRef.current
                      if (!input) return
                      const reference = appReference(app)
                      const logo = resolveAppLogo(app)
                      if (logo.source === 'provided')
                        registerComposerMentionIcon(reference, {
                          url: logo.url,
                          contrastPad: logo.contrastPad,
                        })
                      input.insertReference(reference)
                      input.focus()
                      setPluginTrial(
                        createPluginTrialGuide(displayAppName(app), app.trialTemplates, app)
                      )
                      const recent = [...readRecentPluginAppIds().keys()]
                      window.localStorage.setItem(
                        RECENT_PLUGIN_APPS_KEY,
                        JSON.stringify([app.id, ...recent.filter(id => id !== app.id)].slice(0, 8))
                      )
                    }}
                  />
                )}
              </>
            )}
            className={toolbarProps.className}
            contextUsageIndicator={
              <ContextUsageIndicator
                translate={t}
                usage={conversation.contextUsage ?? undefined}
                disabled={busy || !task}
                onCompactContext={() => void submit(undefined, '/compact')}
              />
            }
            canSend={toolbarProps.canSend}
            disabled={busy || !task}
            models={catalog ?? []}
            selectedModel={selectedModel}
            activeModel={activeModel}
            selectedModelOptions={options}
            isModelSelectionReady={catalog !== null || catalogError !== null}
            onSelectModel={model => setSelection({ model, options })}
            onSelectModelAndOptions={(model, options) => setSelection({ model, options })}
            onSelectModelOption={selectOption}
            onFileSelect={files => void attachments.handleFileSelect(files)}
            planModeActive={options.collaborationMode === 'plan'}
            onSetPlanMode={() => selectOption('collaborationMode', 'plan')}
            onClearPlanMode={() => selectOption('collaborationMode', 'default')}
            isStreaming={running}
            onPause={() => void pause()}
            onSubmit={toolbarProps.onSubmit}
            renderModelSelector={props => (
              <ModelSelector
                {...props}
                translate={t}
                isMobile={isMobile}
                onOpenModelSettings={runtime.openModelSettings}
                onBlockedModelSelect={(_, message) => setError(message ?? t('todo.send_failed'))}
              />
            )}
          />
        )}
      />
    </>
  )
}
