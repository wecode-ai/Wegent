import { Component, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
/* eslint-disable react-refresh/only-export-components -- The registry owns the renderer lifecycle. */
import {
  SlotCore,
  StaleAuthorizationError,
  SlotOwnershipError,
  type RenderOpts,
  type SlotEntryDef,
  type SlotMap,
  type SlotSpec,
  type StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    root: {
      kind: 'single'
      scope: 'root'
      owner: { children: ReactNode }
    }
    'wework.shell.before': {
      kind: 'list'
      scope: 'root'
    }
    'wework.shell.after': {
      kind: 'list'
      scope: 'root'
    }
    'wework.shell.overlay': {
      kind: 'list'
      scope: 'root'
    }
  }
}

type SlotKey = keyof SlotMap & string
type SlotComponentProps = Record<string, unknown>
type SlotComponent = ComponentType<SlotComponentProps>

export interface WorkbenchSlotRegistration {
  name: SlotKey
  component: unknown
  children?: Readonly<Record<string, SlotSpec<SlotEntryDef>>>
  id?: string
  key?: string
  order?: number
  priority?: number
  select?: (owner: SlotComponentProps) => unknown
  inject?: () => SlotComponentProps
  registrant?: string
}

interface SlotOutletProps {
  registry: WorkbenchSlotRegistry
  slotKey: SlotKey
  ownerProps: SlotComponentProps
  options?: RenderOpts
}

interface SlotEntryBoundaryProps {
  children: ReactNode
  entry: StoredEntry
  registry: WorkbenchSlotRegistry
  slotKey: SlotKey
}

class SlotEntryBoundary extends Component<SlotEntryBoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    this.props.registry.reportEntryError(this.props.slotKey, this.props.entry, error)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <div data-slot-error={this.props.slotKey} />
    }
    return this.props.children
  }
}

function SlotOutlet({ registry, slotKey, ownerProps, options }: SlotOutletProps) {
  useSyncExternalStore(
    listener => registry.subscribe(slotKey, listener),
    () => registry.version(slotKey),
    () => registry.version(slotKey)
  )

  const spec = registry.spec(slotKey) as SlotSpec<SlotEntryDef> | undefined
  if (!spec) return options?.fallback ?? null

  let entries = registry.entries(slotKey)
  if (spec.kind === 'keyed') {
    entries = entries.filter(entry => entry.options.key === options?.entryKey)
  } else if (spec.kind === 'list' && options?.only) {
    entries = entries.filter(entry => entry.options.id === options.only)
  } else if (spec.kind === 'chain') {
    const winner = entries.find(entry => entry.select?.(ownerProps as never) != null)
    entries = winner ? [winner] : []
  }

  if (entries.length === 0) return options?.fallback ?? null

  return (
    <>
      {entries.map(entry => (
        <SlotEntry
          key={registry.entryIdentity(entry)}
          entry={entry}
          ownerProps={ownerProps}
          registry={registry}
          slotKey={slotKey}
        />
      ))}
    </>
  )
}

function SlotEntry({
  entry,
  ownerProps,
  registry,
  slotKey,
}: {
  entry: StoredEntry
  ownerProps: SlotComponentProps
  registry: WorkbenchSlotRegistry
  slotKey: SlotKey
}) {
  const Component = entry.component as SlotComponent
  const renderSlot = (key: SlotKey, owner: SlotComponentProps, options?: RenderOpts) => {
    if (!registry.isLive(entry)) {
      throw new StaleAuthorizationError(`renderSlot('${key}') from a disposed registration`)
    }
    if (!entry.children?.[key]) {
      throw new SlotOwnershipError(`slot '${key}' is not declared by this entry`)
    }
    return <SlotOutlet registry={registry} slotKey={key} ownerProps={owner} options={options} />
  }
  const injected = entry.inject?.() ?? {}
  const matched =
    (registry.spec(slotKey) as SlotSpec<SlotEntryDef> | undefined)?.kind === 'chain'
      ? entry.select?.(ownerProps as never)
      : undefined

  return (
    <SlotEntryBoundary registry={registry} slotKey={slotKey} entry={entry}>
      <Component
        {...injected}
        {...ownerProps}
        {...(entry.children ? { renderSlot } : {})}
        {...(matched !== undefined ? { matched } : {})}
      />
    </SlotEntryBoundary>
  )
}

let nextEntryIdentity = 0

export class WorkbenchSlotRegistry {
  private readonly core = new SlotCore()
  private readonly entryIdentities = new WeakMap<StoredEntry, number>()

  register(registration: WorkbenchSlotRegistration): () => void {
    const { component, ...options } = registration
    return this.core.register(options as never, component as never)
  }

  renderRoot(children: ReactNode): ReactNode {
    return (
      <SlotOutlet
        registry={this}
        slotKey="root"
        ownerProps={{ children }}
        options={{ fallback: children }}
      />
    )
  }

  subscribe(key: SlotKey, listener: () => void): () => void {
    return this.core.subscribe(key, listener)
  }

  version(key: SlotKey): number {
    return this.core.getVersion(key)
  }

  spec(key: SlotKey): SlotSpec<SlotEntryDef> | undefined {
    return this.core.spec(key) as SlotSpec<SlotEntryDef> | undefined
  }

  entries(key: SlotKey): readonly StoredEntry[] {
    return this.core.entriesOfSlot(key)
  }

  isLive(entry: StoredEntry): boolean {
    return this.core.isLive(entry)
  }

  reportEntryError(key: SlotKey, entry: StoredEntry, error: unknown): void {
    const kind = this.spec(key)?.kind
    this.core.reportEntryError(key, entry, error, {
      abdicate: kind !== 'chain',
    })
  }

  entryIdentity(entry: StoredEntry): number {
    let identity = this.entryIdentities.get(entry)
    if (identity === undefined) {
      identity = nextEntryIdentity++
      this.entryIdentities.set(entry, identity)
    }
    return identity
  }
}
