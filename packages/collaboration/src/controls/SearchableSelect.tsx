import { createFocusRecovery } from '@ui-sdk/core'
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@ui-sdk/react/combobox'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { Button } from '../markdown/Button'
import { IconButton } from './IconButton'
import { useCollaborationPortalTheme } from '../theme'
import {
  controlOption,
  controlPopup,
  selectionTriggerClasses,
  controlInput,
  type ControlDensity,
  type SelectionTriggerAppearance,
} from './recipes'

export interface SearchableSelectOption<T extends string = string> {
  value: T
  label: string
  accessibleLabel?: string
  description?: string
  group?: string
  section?: string
  searchText?: string
  icon?: ReactNode
  badge?: ReactNode
  disabled?: boolean
  testId?: string
  attributes?: Record<`data-${string}`, string>
}

export interface SearchableSelectAction {
  label: string
  icon?: ReactNode
  testId: string
  onSelect(): void
}

interface SearchableSelectCommonProps<T extends string> {
  options: SearchableSelectOption<T>[]
  actions?: SearchableSelectAction[]
  testId: string
  menuTestId?: string
  searchTestId?: string
  clearSearch?: { label: string; testId: string }
  accessibleLabel: string
  className?: string
  density?: ControlDensity
  appearance?: SelectionTriggerAppearance
  disabled?: boolean
  searchPlaceholder: string
  emptyLabel: string
  emptyTestId?: string
  searchInvalid?: boolean
  searchDescriptionId?: string
  triggerContent?: ReactNode
  triggerTitle?: string
  footer?: ReactNode
  contentClassName?: string
  modal?: boolean
  groupLimit?: number
  open?: boolean
  onOpenChange?(open: boolean): void
  showAllLabel?(group: string, count: number): string
  onSearchChange?(query: string): void
  searchStatus?: ReactNode
  query?: string
  filter?: boolean
  renderOptions?(list: ReactNode): ReactNode
  portalContainer?: Element | null
  anchor?: HTMLElement | null
  hideTrigger?: boolean
  header?: ReactNode
  preview?: ReactNode
  autoHighlight?: boolean | 'always' | 'selected'
  onHighlight?(option: SearchableSelectOption<T> | null): void
}

export type SearchableSelectProps<T extends string> = SearchableSelectCommonProps<T> &
  (
    | {
        multiple?: false
        value: T | null
        activateSelected?: boolean
        onChange(value: T): void
      }
    | {
        multiple: true
        value: T[]
        activateSelected?: never
        onChange(value: T[]): void
      }
  )

export function SearchableSelect<T extends string>(props: SearchableSelectProps<T>) {
  const {
    multiple = false,
    query: controlledQuery,
    filter = true,
    renderOptions = list => list,
    portalContainer,
    anchor,
    hideTrigger = false,
    header,
    preview,
    autoHighlight,
    onHighlight,
    value,
    options,
    actions = [],
    testId,
    menuTestId,
    searchTestId,
    clearSearch,
    accessibleLabel,
    className,
    density = 'default',
    appearance = 'outline',
    disabled,
    searchPlaceholder,
    emptyLabel,
    emptyTestId,
    searchInvalid,
    searchDescriptionId,
    triggerContent,
    triggerTitle,
    footer,
    contentClassName,
    modal = false,
    groupLimit,
    showAllLabel,
    open: controlledOpen,
    onOpenChange,
    onSearchChange,
    searchStatus,
  } = props
  const theme = useCollaborationPortalTheme()
  const [localTrigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const trigger = anchor ?? localTrigger
  const searchRef = useRef<HTMLInputElement>(null)
  const restoreTrigger = useRef(false)
  const selectionFocus = useRef<HTMLElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!hideTrigger || !content) return
    const recovery = createFocusRecovery({
      fallback: () =>
        restoreTrigger.current && trigger?.isConnected && !trigger.closest('[hidden], [inert]')
          ? trigger
          : undefined,
    })
    return recovery.bind(content, {
      key: 'external-picker-content',
      props: {},
    })
  }, [content, hideTrigger, trigger])
  const [internalOpen, setInternalOpen] = useState(false)
  const [internalQuery, setInternalQuery] = useState('')
  const query = controlledQuery ?? internalQuery
  const setQuery = (next: string) => {
    setInternalQuery(next)
    onSearchChange?.(next)
  }
  const values: T[] = Array.isArray(value) ? value : value === null ? [] : [value]
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const selected = options.find(option => values.includes(option.value))
  const normalized = query.trim().toLocaleLowerCase()
  const counts = new Map<string, number>()
  const totals = new Map<string, number>()
  const limit = showAllLabel ? groupLimit : undefined
  for (const option of options)
    if (option.group) totals.set(option.group, (totals.get(option.group) ?? 0) + 1)
  const visible = options.filter(option => {
    if (normalized && filter)
      return [option.label, option.description, option.searchText, option.group, option.section]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalized)
    if (!option.group || !limit || expanded.has(option.group)) return true
    const count = counts.get(option.group) ?? 0
    if (count < limit || values.includes(option.value)) {
      counts.set(option.group, count + 1)
      return true
    }
    return false
  })
  const collapsed =
    !normalized && limit
      ? [...totals].filter(([group, count]) => count > limit && !expanded.has(group))
      : []
  const setOpen = (next: boolean) => {
    setInternalOpen(next)
    onOpenChange?.(next)
  }
  return (
    <Combobox<T, boolean>
      items={visible}
      autoHighlight={autoHighlight}
      onHighlight={next => onHighlight?.(options.find(option => option.value === next) ?? null)}
      multiple={multiple}
      value={props.activateSelected ? null : value}
      disabled={disabled}
      open={controlledOpen ?? internalOpen}
      modal={modal}
      query={query}
      filter={false}
      itemToLabel={key => options.find(option => option.value === key)?.label ?? key}
      onValueChange={(next, details) => {
        if (details.reason === 'item-press') restoreTrigger.current = true
        const focusedBefore = trigger?.ownerDocument.activeElement
        if (props.multiple) {
          if (Array.isArray(next)) props.onChange(next)
        } else if (next !== null && !Array.isArray(next)) props.onChange(next)
        const focused = trigger?.ownerDocument.activeElement
        selectionFocus.current =
          focused instanceof HTMLElement &&
          focused !== focusedBefore &&
          focused !== trigger?.ownerDocument.body &&
          !content?.contains(focused)
            ? focused
            : null
      }}
      onQueryChange={(next, details) => {
        if (['input-change', 'clear-press'].includes(details.reason)) setQuery(next)
      }}
      onOpenChangeComplete={open => {
        if (hideTrigger || open || !restoreTrigger.current) return
        restoreTrigger.current = false
        const focused = trigger?.ownerDocument.activeElement
        const explicitFocus = selectionFocus.current
        selectionFocus.current = null
        if (explicitFocus?.isConnected && focused === explicitFocus) return
        const focusedDialog = focused?.closest('[role="dialog"], [role="alertdialog"]')
        if (
          focusedDialog &&
          focusedDialog !== trigger?.closest('[role="dialog"], [role="alertdialog"]')
        )
          return
        if (trigger?.isConnected && !trigger.closest('[hidden], [inert]')) trigger.focus()
      }}
      onOpenChange={(next, details) => {
        if (
          !next &&
          hideTrigger &&
          anchor &&
          details.reason === 'outside-press' &&
          details.event?.target instanceof Node &&
          anchor.contains(details.event.target)
        ) {
          details.cancel()
          return
        }
        restoreTrigger.current =
          !next && ['escape-key', 'item-press', 'close-press'].includes(details.reason)
        setOpen(next)
        if (next) {
          setQuery('')
          setExpanded(new Set())
        }
      }}
    >
      {!hideTrigger && (
        <ComboboxTrigger
          ref={setTrigger}
          data-testid={testId}
          data-value={values.join(',')}
          aria-label={accessibleLabel}
          title={
            triggerTitle ??
            (selected
              ? [selected.group, selected.label, selected.description].filter(Boolean).join(' · ')
              : values.join(', '))
          }
          className={cn(selectionTriggerClasses(appearance, density), className)}
        >
          {triggerContent ?? (
            <>
              <span className="min-w-0 flex-1 truncate">
                {selected?.label ?? searchPlaceholder}
              </span>
              <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
            </>
          )}
        </ComboboxTrigger>
      )}
      <ComboboxContent
        ref={setContent}
        {...theme}
        container={portalContainer ?? trigger?.closest('[role="dialog"][aria-modal="true"]')}
        anchor={trigger}
        data-testid={menuTestId ?? `${testId}-menu`}
        data-embedded-browser-occlusion
        aria-label={accessibleLabel}
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          theme.className,
          controlPopup,
          'flex w-72 flex-col overflow-hidden',
          contentClassName
        )}
      >
        {header}
        <div
          className={cn(
            controlInput,
            'flex shrink-0 items-center gap-2 px-2.5 text-text-secondary',
            'keyboard:focus-within:ring-2 keyboard:focus-within:ring-focus/40'
          )}
        >
          <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
          <ComboboxInput
            autoFocus
            ref={searchRef}
            data-testid={searchTestId ?? `${testId}-search`}
            aria-invalid={searchInvalid || undefined}
            aria-describedby={searchDescriptionId}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="min-w-0 flex-1 self-stretch bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
          />
          {clearSearch && query && (
            <IconButton
              type="button"
              density="compact"
              aria-label={clearSearch.label}
              data-testid={clearSearch.testId}
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              <X aria-hidden="true" />
            </IconButton>
          )}
        </div>
        {searchStatus}
        {renderOptions(
          <ComboboxList
            aria-label={accessibleLabel}
            className="mt-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            {visible.map((option, index) => (
              <Fragment key={option.value}>
                {index > 0 &&
                  visible[index - 1].section &&
                  option.section !== visible[index - 1].section && (
                    <div
                      aria-hidden="true"
                      data-testid={`${testId}-section-divider-${index}`}
                      className="mx-2 my-1 border-t border-border"
                    />
                  )}
                {option.section && option.section !== visible[index - 1]?.section && (
                  <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-text-secondary">
                    {option.section}
                  </p>
                )}
                {option.group && option.group !== visible[index - 1]?.group && (
                  <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-text-secondary">
                    {option.group}
                  </p>
                )}
                <ComboboxItem
                  {...option.attributes}
                  render={(props, state) => <div {...props} data-active={state.highlighted} />}
                  value={option.value}
                  label={option.label}
                  aria-label={option.accessibleLabel}
                  disabled={option.disabled}
                  aria-current={
                    props.activateSelected && values.includes(option.value) ? true : undefined
                  }
                  data-testid={option.testId ?? `${testId}-option-${option.value || 'empty'}`}
                  className={cn(
                    controlOption,
                    option.section && 'mb-0.5',
                    values.includes(option.value) && 'bg-muted font-medium'
                  )}
                >
                  {option.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description && (
                      <span className="block truncate text-xs text-text-secondary">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {option.badge}
                  {values.includes(option.value) && (
                    <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
                  )}
                </ComboboxItem>
              </Fragment>
            ))}
          </ComboboxList>
        )}
        {!visible.length && !searchStatus && (
          <p
            data-testid={emptyTestId}
            className="px-3 py-6 text-center text-sm text-text-secondary"
          >
            {emptyLabel}
          </p>
        )}
        {collapsed.map(([group, count]) => (
          <Button
            key={group}
            variant="ghost"
            data-testid={`${testId}-show-all-${group}`}
            onClick={() => {
              setExpanded(current => new Set([...current, group]))
              searchRef.current?.focus()
            }}
            className="shrink-0 justify-start text-text-secondary"
          >
            {showAllLabel?.(group, count)}
          </Button>
        ))}
        {!!actions.length && (
          <div className="mt-1 shrink-0 border-t border-border pt-1">
            {actions.map(action => (
              <Button
                key={action.testId}
                variant="ghost"
                data-testid={action.testId}
                onClick={() => {
                  setOpen(false)
                  action.onSelect()
                }}
                className="w-full justify-start"
              >
                {action.icon}
                {action.label}
              </Button>
            ))}
          </div>
        )}
        {preview}
        {footer && <div className="mt-1 shrink-0 border-t border-border pt-1">{footer}</div>}
      </ComboboxContent>
    </Combobox>
  )
}
