import { BlockNoteSdkPopupContext, useBlockNoteSdkPopupRef } from './blockNoteSdkPopupPresence'
import {
  ComponentsContext,
  BlockNoteViewRaw,
  useBlockNoteEditor,
  type ComponentProps,
  type Components,
} from '@blocknote/react'
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '@wegent/collaboration/controls/MenuParts'
import { Popover, PopoverContent, PopoverTrigger } from '@wegent/collaboration/controls/Popover'
import { TabsRoot, TabsList, TabsPanel, TabsTab } from '@wegent/collaboration/controls/Tabs'
import { Tooltip } from '@wegent/collaboration/controls/Tooltip'
import { TextField } from '@wegent/collaboration/controls/TextField'
import { Button } from '@wegent/collaboration/markdown/Button'
import { ProgressRing } from '@wegent/collaboration/controls/ProgressBar'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import {
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useId,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { ToolbarRoot, ToolbarButton, ToolbarSelect } from './BlockNoteSdkFormattingToolbar'
const blockNoteSdkToolbarComponents = {
  Root: ToolbarRoot,
  Button: ToolbarButton,
  Select: ToolbarSelect,
}

type MenuPlacement = ComponentProps['Generic']['Menu']['Root']['position']
const Placement = createContext<{ position?: MenuPlacement; container?: HTMLElement | null }>({})
function placement(position?: MenuPlacement) {
  return {
    side: position?.startsWith('top')
      ? 'top'
      : position?.startsWith('left')
        ? 'left'
        : position?.startsWith('right')
          ? 'right'
          : 'bottom',
    align: position?.endsWith('end') ? 'end' : position?.endsWith('start') ? 'start' : 'center',
  } as const
}
function SectionLabel({ className, children }: ComponentProps['Generic']['Menu']['Label']) {
  return <div className={cn('px-2.5 py-1 text-xs text-text-muted', className)}>{children}</div>
}
function MenuRoot({
  sub,
  onOpenChange,
  position,
  children,
}: ComponentProps['Generic']['Menu']['Root']) {
  const editor = useBlockNoteEditor()
  const Root = sub ? MenuSub : Menu
  return (
    <Placement.Provider value={{ position, container: editor.portalElement }}>
      <Root
        onOpenChange={next => {
          onOpenChange?.(next)
        }}
      >
        {children}
      </Root>
    </Placement.Provider>
  )
}
function MenuDropdown({ sub, className, children }: ComponentProps['Generic']['Menu']['Dropdown']) {
  const { position, container } = useContext(Placement)
  const Content = sub ? MenuSubContent : MenuContent
  const popupRef = useBlockNoteSdkPopupRef()
  return (
    <Content
      ref={popupRef}
      container={container}
      {...placement(position ?? (sub ? 'right-start' : 'bottom-start'))}
      className={className}
    >
      {children}
    </Content>
  )
}
function MenuEntry({
  subTrigger,
  children,
  className,
  icon,
  checked,
  onClick,
  ...props
}: ComponentProps['Generic']['Menu']['Item']) {
  const value = useId()
  const body = (
    <>
      {icon && (
        <span aria-hidden="true" className="shrink-0">
          {icon}
        </span>
      )}
      {children}
    </>
  )
  if (subTrigger)
    return (
      <MenuSubTrigger {...props} className={className}>
        {body}
      </MenuSubTrigger>
    )
  if (checked !== undefined)
    return (
      <MenuCheckboxItem
        {...props}
        value={value}
        checked={checked}
        onCheckedChange={() => onClick?.()}
        className={className}
      >
        {body}
      </MenuCheckboxItem>
    )
  return (
    <MenuItem {...props} value={value} onSelect={onClick} className={className}>
      {body}
    </MenuItem>
  )
}
function MenuTarget({ sub, children }: ComponentProps['Generic']['Menu']['Trigger']) {
  if (sub) return children
  return <MenuTrigger render={isValidElement(children) ? children : <span>{children}</span>} />
}
const MenuButton = forwardRef<HTMLButtonElement, ComponentProps['Generic']['Menu']['Button']>(
  function MenuButton({ children, icon, label, className, ...props }, ref) {
    return (
      <Button
        {...props}
        ref={ref}
        variant="ghost"
        size={children ? 'sm' : 'icon'}
        aria-label={label}
        className={className}
      >
        {children ?? icon}
      </Button>
    )
  }
)
function PopoverRoot({
  open,
  onOpenChange,
  position,
  portalRoot,
  children,
}: ComponentProps['Generic']['Popover']['Root']) {
  const editor = useBlockNoteEditor()
  return (
    <Placement.Provider
      value={{ position, container: portalRoot !== undefined ? portalRoot : editor.portalElement }}
    >
      <Popover
        open={open}
        onOpenChange={next => {
          onOpenChange?.(next)
        }}
      >
        {children}
      </Popover>
    </Placement.Provider>
  )
}
function PopoverBody({ className, children }: ComponentProps['Generic']['Popover']['Content']) {
  const { position, container } = useContext(Placement)
  const popupRef = useBlockNoteSdkPopupRef()
  return (
    <PopoverContent
      ref={popupRef}
      {...placement(position)}
      container={container}
      className={cn('p-2', className)}
    >
      {children}
    </PopoverContent>
  )
}
function PopoverTarget({ children }: ComponentProps['Generic']['Popover']['Trigger']) {
  return <PopoverTrigger render={isValidElement(children) ? children : <span>{children}</span>} />
}
function FormInput({
  className,
  name,
  label,
  variant,
  icon,
  rightSection,
  ref,
  ...props
}: ComponentProps['Generic']['Form']['TextInput']) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <span className="relative flex min-w-0 items-center gap-2">
        {icon}
        <TextField
          {...props}
          ref={ref}
          name={name}
          aria-label={label ?? props.placeholder ?? name}
          density={variant === 'large' ? 'default' : 'dense'}
          className={cn('min-w-0 flex-1', className)}
        />
        {rightSection}
      </span>
    </label>
  )
}
function Badge({
  className,
  text,
  icon,
  isSelected,
  mainTooltip,
  secondaryTooltip,
  ...props
}: ComponentProps['Generic']['Badge']['Root']) {
  const button = (
    <Button {...props} variant="ghost" size="sm" aria-pressed={isSelected} className={className}>
      {icon}
      {text}
    </Button>
  )
  return mainTooltip ? (
    <Tooltip label={[mainTooltip, secondaryTooltip].filter(Boolean).join(' · ')}>{button}</Tooltip>
  ) : (
    button
  )
}
function FileRoot({
  className,
  tabs,
  openTab,
  setOpenTab,
  loading,
}: ComponentProps['FilePanel']['Root']) {
  return (
    <div className={cn('min-w-72', className)} aria-busy={loading}>
      <TabsRoot
        value={openTab}
        onValueChange={value => {
          if (value !== null) setOpenTab(value)
        }}
      >
        <TabsList>
          {tabs.map(tab => (
            <TabsTab key={tab.name} value={tab.name}>
              {tab.name}
            </TabsTab>
          ))}
        </TabsList>
        {tabs.map(tab => (
          <TabsPanel key={tab.name} value={tab.name}>
            {tab.tabPanel}
          </TabsPanel>
        ))}
      </TabsRoot>
    </div>
  )
}
function FileInput({
  className,
  accept,
  placeholder,
  onChange,
}: ComponentProps['FilePanel']['FileInput']) {
  return (
    <TextField
      className={className}
      type="file"
      accept={accept}
      aria-label={placeholder}
      onChange={event => onChange(event.target.files?.[0] ?? null)}
    />
  )
}
function FileText({ className, placeholder, ...props }: ComponentProps['FilePanel']['TextInput']) {
  return (
    <TextField
      {...props}
      className={className}
      placeholder={placeholder}
      aria-label={placeholder}
    />
  )
}
function PanelButton({
  className,
  children,
  label,
  onClick,
}: ComponentProps['FilePanel']['Button']) {
  return (
    <Button className={className} onClick={onClick} aria-label={label} size="sm">
      {children ?? label}
    </Button>
  )
}
function Panel({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={className}>
      {children}
    </div>
  )
}
function SuggestionItem({
  className,
  id,
  isSelected,
  onClick,
  item,
}: ComponentProps['SuggestionMenu']['Item']) {
  return (
    <Button
      id={id}
      data-selected={isSelected || undefined}
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn(
        'flex w-full justify-start gap-2 text-left data-[selected]:bg-muted',
        className
      )}
    >
      {item.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.title}</span>
        <span className="block text-xs text-text-secondary">{item.subtext}</span>
      </span>
      {item.badge}
    </Button>
  )
}
function GridItem({
  className,
  id,
  isSelected,
  onClick,
  item,
}: ComponentProps['GridSuggestionMenu']['Item']) {
  return (
    <Button
      id={id}
      data-selected={isSelected || undefined}
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={item.id}
      className={cn('data-[selected]:bg-muted', className)}
    >
      {item.icon}
    </Button>
  )
}
function GridRoot({
  id,
  columns,
  className,
  children,
}: ComponentProps['GridSuggestionMenu']['Root']) {
  return (
    <div
      id={id}
      className={cn('grid gap-1', className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  )
}
function Loader({ className }: { className?: string }) {
  const { t } = useTranslation('common')
  return <ProgressRing value={null} label={t('common.loading')} className={className} />
}
function TableRoot({
  className,
  children,
  label,
  style,
  ...props
}: ComponentProps['TableHandle']['Root']) {
  const editor = useBlockNoteEditor()
  return (
    <Button
      {...props}
      style={style}
      variant="ghost"
      size="icon"
      aria-label={label ?? editor.dictionary.side_menu.drag_handle_label}
      className={className}
    >
      {children}
    </Button>
  )
}
function Extend({ className, children, ...props }: ComponentProps['TableHandle']['ExtendButton']) {
  const editor = useBlockNoteEditor()
  const label = className?.includes('bn-extend-button-add-remove-columns')
    ? editor.dictionary.table_handle.add_right_menuitem
    : editor.dictionary.table_handle.add_below_menuitem
  return (
    <Button {...props} variant="ghost" size="sm" aria-label={label} className={className}>
      {children}
    </Button>
  )
}
function CommentEditor({
  editor,
  editable,
  autoFocus,
  onFocus,
  onBlur,
  className,
}: ComponentProps['Comments']['Editor']) {
  return (
    <BlockNoteViewRaw
      editor={editor}
      editable={editable}
      autoFocus={autoFocus}
      onFocus={onFocus}
      onBlur={onBlur}
      className={className}
      formattingToolbar={false}
      slashMenu={false}
      sideMenu={false}
      linkToolbar={false}
      filePanel={false}
      tableHandles={false}
      emojiPicker={false}
      comments={false}
    />
  )
}

const blockNoteSdkComponents = {
  FormattingToolbar: blockNoteSdkToolbarComponents,
  LinkToolbar: blockNoteSdkToolbarComponents,
  SideMenu: { Root: Panel, Button: MenuButton },
  FilePanel: {
    Root: FileRoot,
    Button: PanelButton,
    FileInput,
    TabPanel: Panel,
    TextInput: FileText,
  },
  SuggestionMenu: {
    Root: ({ id, ...props }) => <div {...props} id={id} />,
    EmptyItem: Panel,
    Item: SuggestionItem,
    Label: SectionLabel,
    Loader,
  },
  GridSuggestionMenu: { Root: GridRoot, EmptyItem: Panel, Item: GridItem, Loader },
  TableHandle: { Root: TableRoot, ExtendButton: Extend },
  Comments: {
    Card: ({ className, children, onFocus, onBlur, tabIndex }) => (
      <div className={className} onFocus={onFocus} onBlur={onBlur} tabIndex={tabIndex}>
        {children}
      </div>
    ),
    CardSection: Panel,
    ExpandSectionsPrompt: Panel,
    Editor: CommentEditor,
    Comment: ({ className, children, actions, authorInfo, timeString }) => (
      <article className={className}>
        <header>
          {typeof authorInfo === 'object' ? authorInfo.username : ''}
          <time>{timeString}</time>
          {actions}
        </header>
        {children}
      </article>
    ),
  },
  Versioning: {
    Sidebar: Panel,
    Snapshot: ({ className, children, onClick, actions }) => (
      <div className={className}>
        <Button variant="ghost" onClick={onClick}>
          {children}
        </Button>
        {actions}
      </div>
    ),
  },
  AttributionTooltip: { Root: Panel },
  Generic: {
    Toolbar: blockNoteSdkToolbarComponents,
    Badge: { Root: Badge, Group: Panel },
    Form: {
      Root: ({ children }) => <form onSubmit={event => event.preventDefault()}>{children}</form>,
      TextInput: FormInput,
    },
    Menu: {
      Root: MenuRoot,
      Dropdown: MenuDropdown,
      Item: MenuEntry,
      Trigger: MenuTarget,
      Button: MenuButton,
      Label: SectionLabel,
      Divider: MenuSeparator,
    },
    Popover: { Root: PopoverRoot, Content: PopoverBody, Trigger: PopoverTarget },
  },
} satisfies Components

export function BlockNoteSdkProvider({ children }: { children: ReactNode }) {
  const [popups] = useState(() => new Set<symbol>())
  return (
    <BlockNoteSdkPopupContext.Provider value={popups}>
      <ComponentsContext.Provider value={blockNoteSdkComponents}>
        {children}
      </ComponentsContext.Provider>
    </BlockNoteSdkPopupContext.Provider>
  )
}
