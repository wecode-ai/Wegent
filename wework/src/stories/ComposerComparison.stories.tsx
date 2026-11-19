import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import type { UnifiedModel, ModelOptions } from '@wegent/chat-core/models'
import { useMemo, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { userEvent, within } from 'storybook/test'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { WeworkIssueHomeComposer } from '@/features/todo/WeworkIssueHomeComposer'
import { ComposerCatalogContext } from '@/components/chat/composer/ComposerCatalogContext'
import { ComposerProjectSelector, type ComposerInputHandle } from '@wegent/collaboration/composer'
import { IssueHomeComposer, type IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'
import { createComposerCatalogStore } from '../../../packages/collaboration/src/composer/createComposerCatalogStore'
import { createCollaborationTranslator, type CollaborationProject } from '@wegent/collaboration'
import type { LocalDeviceApp } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

const meta = {
  title: 'Patterns/ComposerComparison',
  component: BufferedChatInput,
  parameters: {
    docs: {
      description: {
        component:
          'Production desktop chains: ordinary task → BufferedChatInput; record/create → IssueHomeComposer → WeworkIssueHomeComposer → BufferedChatInput. All reach ProjectComposerBody, ProjectChatComposerSurface and ComposerToolbar. Catalog and submission ports use local fixture data; editors and toolbars are not mocked. / 三条生产链共用真实编辑器、表面和工具栏，仅目录与提交端口使用本地数据。',
      },
    },
  },
} satisfies Meta<typeof BufferedChatInput>
export default meta
type Story = StoryObj<Record<string, never>>
const listEmpty = async () => []
const projects: CollaborationProject[] = ['local', 'backend'].map((store, index) => ({
  id: 'example-' + index,
  public_id: 'example-' + index,
  project_key: 'DEMO-' + index,
  name: store === 'local' ? 'Example local project' : 'Example cloud project',
  description: '',
  project_store: store as 'local' | 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}))
const models: UnifiedModel[] = [
  {
    name: 'example-model',
    modelId: 'example-model',
    displayName: 'Example model',
    type: 'runtime',
    provider: 'local',
    config: {
      weworkModelKind: 'codex-official',
      ui: {
        family: 'codex-official',
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
    },
  },
]
function useTaskControls(
  port?: Pick<IssueHomeTaskComposerProps, 'attachments' | 'onFileSelect' | 'onRemoveAttachment'>
): ProjectChatControls {
  const [selectedModel, setSelectedModel] = useState<UnifiedModel | null>(models[0])
  const [selectedModelOptions, setOptions] = useState<ModelOptions>({ reasoning_effort: 'medium' })
  return {
    models,
    skills: [],
    selectedModel,
    selectedModelOptions,
    isModelSelectionReady: true,
    selectedSkills: [],
    attachments: port?.attachments ?? [],
    uploadingFiles: new Map(),
    errors: new Map(),
    isOptionsLocked: false,
    setSelectedModel,
    setSelectedModelOption: (key, value) => setOptions(current => ({ ...current, [key]: value })),
    toggleSkill: () => {},
    handleFileSelect: async files => port?.onFileSelect(files),
    removeAttachment: async id => port?.onRemoveAttachment(id),
    listLocalSkills: listEmpty,
    listLocalApps: listEmpty,
  }
}
function TaskPort({ ref: inputRef, ...props }: IssueHomeTaskComposerProps) {
  const controls = useTaskControls(props)
  return (
    <BufferedChatInput
      inputRef={inputRef}
      value={props.value}
      onChange={props.onChange}
      onDraftEdit={props.onDraftChange}
      onSubmit={value => props.onSubmit(value ?? props.value)}
      disabled={props.disabled}
      requireText
      placeholder={props.placeholder}
      variant="desktop"
      presentation="chat"
      alwaysShowComposerToolbar
      showProjectWorkBar={false}
      showWorkspaceMenu={false}
      showPluginPicker={false}
      toolbarLeadingContext={
        <>
          {props.projectControl}
          {props.ownerControl}
        </>
      }
      projectChat={controls}
      error={props.error}
      externalMentionCandidates={props.members}
      mentionScope="external"
      inputTestId="catalog-created-task-input"
    />
  )
}
function IssueExample({ creation = false }) {
  const { t, i18n } = useTranslation('componentCatalog')
  const translate = createCollaborationTranslator(i18n.language === 'en' ? 'en' : 'zh-CN')
  const input = useRef<ComposerInputHandle>(null)
  const [value, onChange] = useState('')
  const [projectId, onSelectProject] = useState(projects[0].id)
  const [result, setResult] = useState('')
  return (
    <section
      className="min-w-0 space-y-3"
      data-testid={creation ? 'catalog-creation-composer' : 'catalog-record-composer'}
    >
      <h2 className="text-base font-medium">{t(creation ? 'createTask' : 'recordIssue')}</h2>
      <IssueHomeComposer
        ref={input}
        value={value}
        onChange={onChange}
        onSubmit={async text => {
          setResult(text)
          return true
        }}
        pending={false}
        members={[
          { id: 2, user_id: 2, user_name: 'Alex', email: 'alex@example.test', role: 'Developer' },
        ]}
        projects={projects}
        projectId={projectId}
        onSelectProject={onSelectProject}
        translate={translate}
        placeholder={t('inputHint')}
        projectLabel={t('project')}
        memberLabel={t('person')}
        error={null}
        renderTaskComposer={port => (
          <WeworkIssueHomeComposer
            {...port}
            renderTaskComposer={taskPort => <TaskPort {...taskPort} />}
          />
        )}
      />
      <output aria-live="polite">{result}</output>
    </section>
  )
}
function Comparison() {
  const controls = useTaskControls()
  const { t } = useTranslation('componentCatalog')
  const catalog = useMemo(
    () => ({
      appsStore: createComposerCatalogStore<LocalDeviceApp>(),
      catalogEvents: {},
      listApps: listEmpty,
      listSkills: listEmpty,
    }),
    []
  )
  const [value, onChange] = useState('')
  const [project, onProject] = useState(projects[0].id)
  const [result, setResult] = useState('')
  return (
    <AppPreferencesContext.Provider value={{ preferences: defaultAppPreferences, loaded: true }}>
      <ComposerCatalogContext.Provider value={catalog}>
        <div className="grid min-w-0 gap-8 lg:grid-cols-3">
          <section className="min-w-0 space-y-3" data-testid="catalog-ordinary-composer">
            <h2 className="text-base font-medium">{t('ordinaryTask')}</h2>
            <BufferedChatInput
              value={value}
              onChange={onChange}
              onSubmit={text => setResult(text ?? value)}
              disabled={false}
              requireText
              variant="desktop"
              presentation="chat"
              placeholder={t('inputHint')}
              alwaysShowComposerToolbar
              showProjectWorkBar={false}
              showWorkspaceMenu={false}
              showPluginPicker={false}
              projectChat={controls}
              toolbarLeadingContext={
                <ComposerProjectSelector
                  value={project}
                  options={projects.map(p => ({ value: p.id, label: p.name }))}
                  onChange={onProject}
                  label={t('project')}
                  testId="catalog-ordinary-project"
                />
              }
              inputTestId="catalog-ordinary-task-input"
            />
            <output aria-live="polite">{result}</output>
          </section>
          <IssueExample />
          <IssueExample creation />
        </div>
      </ComposerCatalogContext.Provider>
    </AppPreferencesContext.Provider>
  )
}
export const ThreeProductionFlows: Story = {
  render: () => <Comparison />,
  play: async ({ canvasElement }) => {
    const region = canvasElement.querySelector<HTMLElement>(
      '[data-testid="catalog-creation-composer"]'
    )!
    await userEvent.click(within(region).getByTestId('personal-home-new-issue'))
  },
}
