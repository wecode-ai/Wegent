import type { ComponentType, ReactNode, Ref, RefObject } from 'react'
import type { UnifiedModel, ModelOptions } from '@wegent/chat-core/models'
import type { LocalDeviceApp, LocalDeviceSkill } from '@wegent/chat-core/runtime-composer-catalog'
import type { PluginReference } from '@wegent/chat-core/plugin-reference'
import type { CollaborationTranslate } from '../i18n'
import type { ComposerTextInputProps } from './ComposerTextInput'
import type { ComposerEditorHandle } from './ComposerProseMirrorEditor'
import type { ComposerInputHandle } from './composerInputTypes'
import type { ComposerCatalogStore, ComposerCatalogEvents } from './useComposerCatalog'
import type { ComposerMentionCandidate } from './composerMentionCandidates'
import type { WorkspaceMentionSearchApi, WorkspaceMentionTarget } from './workspaceMentionTypes'
import type { SlashCommand } from './composerAutocomplete'
import type { ComposerPathTransfer } from './useComposerTransfers'

export type ComposerCatalogCommand = SlashCommand<LocalDeviceApp, LocalDeviceSkill>
export interface ComposerExternalMentionCandidate {
  reference?: string
  id: string
  type: 'agent' | 'user' | 'group' | 'issue'
  title: string
  metaLabel: string
  searchAliases?: string[]
  testId?: string
}
export interface ComposerHostBindingProps {
  value: string
  valueRef: RefObject<string>
  editorRef: RefObject<ComposerEditorHandle | null>
  textareaRef: RefObject<HTMLElement | null>
  commitEditorValue(value: string, cursor: number): void
  closeAutocompleteMenu(): void
}
export interface ComposerCommandEditor {
  focus(): void
  getValue(): string
  insertText(text: string): void
  setValue(value: string, cursor?: number): void
}
export interface ComposerAutocompleteInputProps<
  Project = unknown,
  Conversation = unknown,
> extends Omit<ComposerTextInputProps, 'onSubmit' | 'testId'> {
  ref?: Ref<ComposerInputHandle>
  translate: CollaborationTranslate
  onSubmit(value?: string, options?: import('./composerInputTypes').ComposerSubmitOptions): void
  testId?: string
  skillMenuClassName?: string
  disableAutocomplete?: boolean
  onOpenSkillFile?: (path: string) => void
  workspaceTarget?: WorkspaceMentionTarget | null
  workspaceFileApi?: WorkspaceMentionSearchApi
  cloudMentionCandidates?: Extract<
    ComposerMentionCandidate<Project, Conversation>,
    { kind: 'cloud' }
  >[]
  conversationMentionCandidates?: Extract<
    ComposerMentionCandidate<Project, Conversation>,
    { kind: 'conversation' }
  >[]
  cloudProjectCandidates?: Extract<
    ComposerMentionCandidate<Project, Conversation>,
    { kind: 'cloud' }
  >[]
  cloudSpaceEnabled?: boolean
  externalMentionCandidates?: ComposerExternalMentionCandidate[]
  mentionScope?: 'all' | 'external'
  onSelectExternalMention?: (candidate: ComposerExternalMentionCandidate) => void
  onSelectCloudProject?: (project: Project) => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
  onListLocalApps?: () => Promise<LocalDeviceApp[]>
  models?: UnifiedModel[]
  selectedModel?: UnifiedModel | null
  selectedModelOptions?: ModelOptions
  planModeActive?: boolean
  onSetPlanMode?: () => void
  onSetGoal?: () => void
  onSelectModel?: (model: UnifiedModel | null) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  isModelSelectionReady?: boolean
  appsStore?: ComposerCatalogStore<LocalDeviceApp>
  catalogEvents?: ComposerCatalogEvents
  compareApps?: (left: LocalDeviceApp, right: LocalDeviceApp) => number
  resolveAppLogo?: (app: LocalDeviceApp) => {
    url: string | null
    contrastPad: boolean
    source: string
  }
  onSelectApp?: (title: string, app: LocalDeviceApp) => void
  onOpenMarketplace?: () => void
  renderAppIcon?: (command: ComposerCatalogCommand) => ReactNode
  onOpenMentionPlugin?: (reference: PluginReference) => void
  onPickWorkspacePaths?: (path?: string) => Promise<ComposerPathTransfer>
  contributedMentionCandidates?: ComposerMentionCandidate<Project, Conversation>[]
  contributedSlashCommands?: ComposerCatalogCommand[]
  onMentionQueryChange?: (query: string) => void
  onExecuteCommand?: (
    command: NonNullable<ComposerCatalogCommand['extensionCommand']>,
    editor: ComposerCommandEditor
  ) => Promise<unknown>
  Bindings?: ComponentType<ComposerHostBindingProps>
  debug?: (event: string, details: Record<string, unknown>) => void
}
