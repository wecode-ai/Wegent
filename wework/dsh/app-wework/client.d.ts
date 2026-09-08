import type { Context } from '@deepseek-ai/cordis'
import type { SlotKind, SlotScope } from '@deepseek-ai/dsh-client-ui-slots'
import type { WeworkDesktopService } from '@wegent/dsh-electron-host/desktop-service'

export type WeworkContextPrimitive = string | number | boolean | null | undefined

export type WeworkContextExpression =
  | string
  | readonly WeworkContextExpression[]
  | { readonly all: readonly WeworkContextExpression[] }
  | { readonly any: readonly WeworkContextExpression[] }
  | { readonly not: WeworkContextExpression }
  | {
      readonly key: string
      readonly equals?: WeworkContextPrimitive
      readonly notEquals?: WeworkContextPrimitive
      readonly in?: readonly WeworkContextPrimitive[]
    }

export interface WeworkCommandDefinition {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly category?: string
  readonly icon?: string
  readonly enablement?: WeworkContextExpression
}

export interface WeworkCommandInvocation {
  readonly commandId: string
  readonly source: string
  readonly composer?: WeworkComposerCommandApi
  readonly [key: string]: unknown
}

export interface WeworkComposerCommandApi {
  focus(): void
  getValue(): string
  insertText(text: string): void
  setValue(value: string, selectionOffset?: number): void
}

export type WeworkCommandHandler = (
  args: unknown,
  invocation: WeworkCommandInvocation
) => unknown | Promise<unknown>

export interface WeworkMenuContribution {
  readonly id: string
  readonly command: string
  readonly title?: string
  readonly icon?: string
  readonly group?: string
  readonly order?: number
  readonly when?: WeworkContextExpression
  readonly enablement?: WeworkContextExpression
}

export interface WeworkResolvedMenuContribution extends WeworkMenuContribution {
  readonly enabled: boolean
}

export interface WeworkKeybindingContribution {
  readonly id: string
  readonly command: string
  readonly key: string
  readonly mac?: string
  readonly windows?: string
  readonly linux?: string
  readonly when?: WeworkContextExpression
}

export interface WeworkComposerReferenceContribution {
  readonly id: string
  readonly title: string
  readonly reference: string
  readonly description?: string
  readonly metaLabel?: string
  readonly searchAliases?: readonly string[]
  readonly order?: number
  readonly when?: WeworkContextExpression
  readonly enablement?: WeworkContextExpression
}

export interface WeworkResolvedComposerReferenceContribution extends WeworkComposerReferenceContribution {
  readonly enabled: boolean
}

export interface WeworkCommandRegistry {
  register(
    owner: Context,
    definition: WeworkCommandDefinition,
    handler: WeworkCommandHandler
  ): () => void
  get(id: string): WeworkCommandDefinition | null
  list(): readonly WeworkCommandDefinition[]
  execute(
    id: string,
    args?: unknown,
    invocation?: Readonly<Record<string, unknown>>
  ): Promise<unknown>
  subscribe(listener: () => void): () => void
}

export interface WeworkPluginBackendClient {
  request<Result = unknown>(
    method: string,
    params?: Readonly<Record<string, unknown>>
  ): Promise<Result>
}

export interface WeworkPluginBackendRegistry {
  scope(namespace: string): WeworkPluginBackendClient
}

export interface WeworkContextRegistry {
  set(owner: Context, key: string, value: WeworkContextPrimitive): () => void
  get(key: string): WeworkContextPrimitive
  entries(): Readonly<Record<string, WeworkContextPrimitive>>
  matches(expression?: WeworkContextExpression): boolean
  subscribe(listener: () => void): () => void
}

export interface WeworkComposerReferenceRegistry {
  register(owner: Context, contribution: WeworkComposerReferenceContribution): () => void
  list(): readonly WeworkResolvedComposerReferenceContribution[]
  subscribe(listener: () => void): () => void
}

export interface WeworkComposerService {
  readonly references: WeworkComposerReferenceRegistry
  bind(controller: WeworkComposerCommandApi): () => void
  focus(): void
  getValue(): string
  insertText(text: string): void
  setValue(value: string, selectionOffset?: number): void
}

export interface WeworkContribution {
  readonly id: string
  readonly label?: string
  readonly icon?: string
  readonly module?: string
  readonly order?: number
  readonly [key: string]: unknown
}

export interface WeworkLabeledContribution extends WeworkContribution {
  readonly label: string
}

export interface WeworkContributionMap {
  readonly 'wework.action': WeworkContribution
  readonly 'wework.app': WeworkContribution
  readonly 'wework.plugins.action': WeworkContribution
  readonly 'wework.board.card.status': WeworkContribution
  readonly 'wework.composer.action': WeworkContribution
  readonly 'wework.environment.section': WeworkContribution
  readonly 'wework.project.create.section': WeworkContribution
  readonly 'wework.project.work.section': WeworkContribution
  readonly 'wework.route': WeworkContribution
  readonly 'wework.runtime-profile.workspace-policy': WeworkContribution
  readonly 'wework.settings.page': WeworkContribution
  readonly 'wework.settings.section': WeworkContribution
  readonly 'wework.sidebar.navigation': WeworkContribution
  readonly 'wework.shell.after': WeworkContribution
  readonly 'wework.shell.before': WeworkContribution
  readonly 'wework.shell.overlay': WeworkContribution
  readonly 'wework.task.status': WeworkContribution
  readonly 'wework.workspace.menu.section': WeworkContribution
  readonly 'wework.workspace.bottom-panel.tab': WeworkLabeledContribution
  readonly 'wework.workspace.sidebar.tab': WeworkContribution
  readonly 'wework.workspace.tab': WeworkContribution
  readonly 'wework.workspace.toolbar.action': WeworkContribution
}

export interface WeworkContributionCatalog {
  register<Location extends keyof WeworkContributionMap>(
    owner: Context,
    location: Location,
    contribution: WeworkContributionMap[Location]
  ): () => void
  get<Location extends keyof WeworkContributionMap>(
    location: Location,
    id: string
  ): WeworkContributionMap[Location] | null
  list<Location extends keyof WeworkContributionMap>(
    location: Location
  ): readonly WeworkContributionMap[Location][]
}

export interface WeworkProviderDefinition {
  readonly id: string
  readonly label: string
  readonly order?: number
}

export interface WeworkChatContextRequest {
  readonly workspacePath?: string
  readonly prompt?: string
  readonly selection?: Readonly<Record<string, unknown>>
}

export interface WeworkChatContextResult {
  readonly text: string
  readonly references?: readonly Readonly<Record<string, unknown>>[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface WeworkChatProvider extends WeworkProviderDefinition {
  prepareContext(request: WeworkChatContextRequest): Promise<WeworkChatContextResult>
}

export interface WeworkChatProviderRegistry {
  register(owner: Context, provider: WeworkChatProvider): () => void
  get(id: string): WeworkChatProvider | null
  list(): readonly WeworkChatProvider[]
}

export interface WeworkChatService {
  readonly providers: WeworkChatProviderRegistry
  prepareContext(id: string, request: WeworkChatContextRequest): Promise<WeworkChatContextResult>
}

export interface WeworkTestRunRequest {
  readonly workspacePath?: string
  readonly testIds?: readonly string[]
  readonly profile?: string
}

export interface WeworkTestingProvider extends WeworkProviderDefinition {
  discover(request: WeworkTestRunRequest): Promise<unknown>
  run(request: WeworkTestRunRequest): Promise<unknown>
  cancel?(runId: string): Promise<void>
}

export interface WeworkTestingProviderRegistry {
  register(owner: Context, provider: WeworkTestingProvider): () => void
  get(id: string): WeworkTestingProvider | null
  list(): readonly WeworkTestingProvider[]
}

export interface WeworkTestingService {
  readonly providers: WeworkTestingProviderRegistry
  discover(id: string, request: WeworkTestRunRequest): Promise<unknown>
  run(id: string, request: WeworkTestRunRequest): Promise<unknown>
  cancel(id: string, runId: string): Promise<void>
}

export interface WeworkEnvironmentRequest {
  readonly workspacePath?: string
  readonly target?: string
}

export interface WeworkEnvironmentProvider extends WeworkProviderDefinition {
  inspect(request: WeworkEnvironmentRequest): Promise<unknown>
  prepare(request: WeworkEnvironmentRequest): Promise<unknown>
  switchTo?(request: WeworkEnvironmentRequest): Promise<unknown>
}

export interface WeworkEnvironmentProviderRegistry {
  register(owner: Context, provider: WeworkEnvironmentProvider): () => void
  get(id: string): WeworkEnvironmentProvider | null
  list(): readonly WeworkEnvironmentProvider[]
}

export interface WeworkEnvironmentService {
  readonly providers: WeworkEnvironmentProviderRegistry
  inspect(id: string, request: WeworkEnvironmentRequest): Promise<unknown>
  prepare(id: string, request: WeworkEnvironmentRequest): Promise<unknown>
  switchTo(id: string, request: WeworkEnvironmentRequest): Promise<unknown>
}

export interface WeworkMenuRegistry {
  register(owner: Context, location: string, contribution: WeworkMenuContribution): () => void
  list(location: string): readonly WeworkResolvedMenuContribution[]
  subscribe(listener: () => void): () => void
}

export interface WeworkKeybindingRegistry {
  register(owner: Context, contribution: WeworkKeybindingContribution): () => void
  list(): readonly WeworkKeybindingContribution[]
  subscribe(listener: () => void): () => void
}

export type WeworkLocalizedMessages = Readonly<Record<string, string>>

export interface WeworkLocalizationService {
  getLocale(): string
  translate(messages: string | WeworkLocalizedMessages, fallback?: string): string
}

export interface WeworkConfigurationDefinition<
  Value extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly defaults?: Partial<Value>
  readonly properties?: Readonly<Record<string, unknown>>
  readonly validate?: (value: Value) => void
}

export interface WeworkConfigurationRegistry {
  register(owner: Context, definition: WeworkConfigurationDefinition): () => void
  getDefinition(id: string): WeworkConfigurationDefinition | null
  get(id: string): Readonly<Record<string, unknown>> | null
  update(id: string, patch: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>
  subscribe(listener: () => void): () => void
}

export interface WeworkScopedStorage {
  get<Value>(key: string, fallback?: Value): Value
  set(key: string, value: unknown): void
  delete(key: string): void
}

export interface WeworkStorageRegistry {
  scope(namespace: string): WeworkScopedStorage
}

export interface WeworkScopedSecrets {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface WeworkSecretRegistry {
  scope(namespace: string): WeworkScopedSecrets
}

export interface WeworkService {
  readonly host: WeworkDesktopService
  readonly backend: WeworkPluginBackendRegistry
  readonly chat: WeworkChatService
  readonly commands: WeworkCommandRegistry
  readonly composer: WeworkComposerService
  readonly contributions: WeworkContributionCatalog
  readonly context: WeworkContextRegistry
  readonly environments: WeworkEnvironmentService
  readonly menus: WeworkMenuRegistry
  readonly keybindings: WeworkKeybindingRegistry
  readonly localization: WeworkLocalizationService
  readonly configuration: WeworkConfigurationRegistry
  readonly storage: WeworkStorageRegistry
  readonly secrets: WeworkSecretRegistry
  readonly testing: WeworkTestingService
}

export interface WeworkExtensionHost extends Pick<
  WeworkService,
  | 'commands'
  | 'backend'
  | 'chat'
  | 'composer'
  | 'contributions'
  | 'context'
  | 'environments'
  | 'menus'
  | 'keybindings'
  | 'localization'
  | 'configuration'
  | 'storage'
  | 'secrets'
  | 'testing'
> {
  getRevision(): number
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    wework: WeworkService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'wework.internal.catalog': {
      kind: 'single'
      scope: 'root'
      owner: { readonly revision: number }
    }
    'wework.internal.shell': {
      kind: 'single'
      scope: 'root'
      owner: { readonly revision: number }
    }
    'wework.internal.workspace': {
      kind: 'single'
      scope: 'root'
      owner: { readonly revision: number }
    }
    'wework.action': { kind: 'list'; scope: 'root' }
    'wework.app': { kind: 'list'; scope: 'root' }
    'wework.plugins.action': { kind: 'list'; scope: 'root' }
    'wework.board.card.status': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.composer.action': {
      kind: 'list'
      scope: 'session-maybe'
      owner: { readonly compact: boolean; readonly disabled: boolean }
    }
    'wework.environment.section': {
      kind: 'list'
      scope: 'session-maybe'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.project.create.section': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.project.work.section': {
      kind: 'list'
      scope: 'session-maybe'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.route': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.runtime-profile.workspace-policy': { kind: 'list'; scope: 'root' }
    'wework.settings.page': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.settings.section': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.sidebar.navigation': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.shell.after': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.shell.before': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.shell.overlay': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.task.status': {
      kind: 'list'
      scope: 'root'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.workspace.menu.section': {
      kind: 'list'
      scope: 'session-maybe'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.workspace.bottom-panel.tab': {
      kind: 'list'
      scope: 'session-maybe'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.workspace.sidebar.tab': {
      kind: 'list'
      scope: 'session-maybe'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.workspace.tab': {
      kind: 'list'
      scope: 'session-maybe'
      owner: Readonly<Record<string, unknown>>
    }
    'wework.workspace.toolbar.action': {
      kind: 'list'
      scope: 'session-maybe'
      owner: Readonly<Record<string, unknown>>
    }
  }
}

export declare const APP_RUNTIME_READY_EVENT: string
export declare const SLOT_DECLARATIONS: Readonly<
  Record<string, { readonly kind: SlotKind; readonly scope: SlotScope }>
>
export declare const SLOT_GROUP_DECLARATIONS: Readonly<
  Record<string, { readonly kind: 'single'; readonly scope: 'root' }>
>
export declare const SLOT_GROUPS: Readonly<
  Record<string, Readonly<Record<string, { readonly kind: SlotKind; readonly scope: SlotScope }>>>
>
export declare const inject: readonly ['slots', 'weworkDesktop']
export declare function apply(ctx: Context): void
