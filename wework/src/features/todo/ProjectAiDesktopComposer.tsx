import { useEffect, useMemo, useRef, useState } from 'react'
import { ProjectChatComposer } from '@/components/chat/composer/ProjectChatComposer'
import type { ComposerTextareaHandle } from '@/components/chat/composer/ComposerTextarea'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { getDefaultModelOptions } from '@/lib/model-ui'
import type { ModelOptions, UnifiedModel } from '@/types/api'
import type { WorkspaceProjectManagerModelSelection } from '@wegent/collaboration'
import type { CollaborationIssue } from '@wegent/collaboration'
import { createComposerPathReference } from '@wegent/collaboration/composer/composerMentions'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'

interface Props {
  services: WorkbenchServices
  projectId: string
  projectStore?: string
  issues: CollaborationIssue[]
  value: string
  onChange(value: string): void
  onSubmit(value: string, selection?: WorkspaceProjectManagerModelSelection): void
  disabled: boolean
  busy: boolean
  placeholder: string
}

const pluginApi = createLocalCodexPluginApi()

export function ProjectAiDesktopComposer(props: Props) {
  const { t } = useTranslation('common')
  const editor = useRef<ComposerTextareaHandle>(null)
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [modelReady, setModelReady] = useState(false)
  const [selectedModel, setSelectedModel] = useState<UnifiedModel | null>(null)
  const [options, setOptions] = useState<ModelOptions>({})
  const [fileError, setFileError] = useState('')
  useEffect(() => {
    let active = true
    void props.services.modelApi
      .listModels()
      .then(response => {
        if (!active) return
        const available = response.data.filter(
          model => model.isActive !== false && !model.compatibilityDisabled
        )
        setModels(available)
        setSelectedModel(available[0] ?? null)
        setOptions(available[0] ? getDefaultModelOptions(available[0]) : {})
      })
      .catch(() => {
        if (active) setFileError(t('project_ai.model_unavailable'))
      })
      .finally(() => {
        if (active) setModelReady(true)
      })
    return () => {
      active = false
    }
  }, [props.services.modelApi, t])
  const issueMentions = useMemo(
    () =>
      props.issues.map(issue => ({
        id: issue.id,
        type: 'issue' as const,
        title: `#${issue.sequence_number} ${issue.title}`,
        metaLabel: 'Issue',
        reference: `[$#${issue.sequence_number} ${issue.title}](wework-issue://${props.projectId}/${issue.id})`,
        testId: `project-ai-mention-issue-${issue.id}`,
      })),
    [props.issues, props.projectId]
  )
  const submit = (value?: string) =>
    props.onSubmit(
      value ?? editor.current?.getValue() ?? props.value,
      selectedModel
        ? { modelName: selectedModel.name, modelType: selectedModel.type, options }
        : undefined
    )
  const addFiles = (selected: File | File[]) => {
    const files = Array.isArray(selected) ? selected : [selected]
    const paths = files.map(file => window.weworkElectronFiles?.getPathForFile(file)?.trim() ?? '')
    if (props.projectStore !== 'local' || paths.some(path => !path)) {
      setFileError(t('project_ai.file_unavailable'))
      return
    }
    setFileError('')
    for (const path of paths)
      editor.current?.insertReference(createComposerPathReference(path, false))
    editor.current?.focus()
  }
  return (
    <>
      <ProjectChatComposer
        ref={editor}
        value={props.value}
        onChange={props.onChange}
        onSubmit={submit}
        disabled={props.disabled}
        submitDisabled={props.busy}
        requireText
        placeholder={props.placeholder}
        inputTestId="project-ai-message"
        submitButtonTestId="project-ai-send"
        models={models}
        selectedModel={selectedModel}
        selectedModelOptions={options}
        isModelSelectionReady={modelReady}
        attachments={[]}
        uploadingFiles={new Map()}
        attachmentErrors={new Map()}
        onSelectModel={model => {
          setSelectedModel(model)
          setOptions(model ? getDefaultModelOptions(model) : {})
          return true
        }}
        onSelectModelAndOptions={(model, nextOptions) => {
          setSelectedModel(model)
          setOptions(nextOptions)
        }}
        onSelectModelOption={(key, value) => setOptions(current => ({ ...current, [key]: value }))}
        onFileSelect={addFiles}
        onRemoveAttachment={() => {}}
        onListLocalSkills={() => pluginApi.listSkills()}
        onListLocalApps={() => pluginApi.listApps()}
        externalMentionCandidates={issueMentions}
        showProjectWorkBar={false}
        showWorkspaceMenu={false}
        pluginPickerIconOnly
      />
      {fileError && (
        <p
          role="alert"
          data-testid="project-ai-file-error"
          className="px-5 pb-3 text-sm text-red-600"
        >
          {fileError}
        </p>
      )}
    </>
  )
}
