import { insertComposerReference } from './insertComposerReference'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  startTransition,
} from 'react'
import type { LocalDeviceApp, LocalDeviceSkill } from '@wegent/chat-core/runtime-composer-catalog'
import type { UnifiedModel } from '@wegent/chat-core/models'
import type {
  ComposerAutocompleteInputProps,
  ComposerCatalogCommand as SlashCommand,
  ComposerExternalMentionCandidate,
} from './composerAutocompleteInputTypes'
import type { ComposerMentionCandidate as Candidate } from './composerMentionCandidates'
import { matchesMentionQuery } from './composerMentionCandidates'
import { createComposerMentionRows } from './composerMentionRows'
import {
  createComposerActionCommands,
  createSkillSlashCommands,
  createPluginSlashCommands,
} from './composerCatalogCommands'
import { modelCompatibilityDisabledMessage } from '../controls/model-selector-utils'
import { useComposerCatalog } from './useComposerCatalog'
import { createComposerCatalogStore } from './createComposerCatalogStore'
import { useComposerTransfers } from './useComposerTransfers'
import { useComposerLinkEditing } from './useComposerLinkEditing'
import { ComposerErrorBanner } from './ComposerErrorBanner'
import { useComposerInputEvents } from './useComposerInputEvents'
import { useOutsideClick } from './useOutsideClick'
import {
  ComposerProseMirrorEditor,
  type ComposerEditorHandle,
  type ComposerEditorSnapshot,
} from './ComposerProseMirrorEditor'
import {
  resolveComposerAutocompleteTrigger,
  findStandaloneTrigger,
  filterSlashCommands as filterSharedSlashCommands,
  hasDraftTextForSlashCommands,
  parseCloudProjectScopeQuery,
  type ComposerTextTrigger,
} from './composerAutocomplete'
import {
  createComposerPathReference,
  registerComposerMentionIcon,
  replaceComposerMentionTrigger,
  resolveComposerWorkspacePath,
} from './composerMentions'
import { SlashCommandMenu } from './SlashCommandMenu'
import { SlashModelMenu } from './SlashModelMenu'
import { LinkEditPopover } from './LinkEditPopover'
import {
  ComposerMentionMenu,
  type MentionMenuRow as SharedMentionMenuRow,
} from './ComposerMentionMenu'
import { useWorkspaceMentionSearch } from './useWorkspaceMentionSearch'
import { useComposerMentionCandidates } from './useComposerMentionCandidates'
import { ComposerPluginIcon } from './ComposerPluginIcon'
const EMPTY_EVENTS = {}
const noAppLogo = () => ({ url: null, contrastPad: false, source: 'none' })
const defaultAppIcon = (command: SlashCommand) => (
  <ComposerPluginIcon
    name={command.title}
    logo={{
      url: command.iconUrl ?? null,
      contrastPad: Boolean(command.iconContrastPad),
      source: 'provided',
    }}
    className="plugin-icon-slot h-6 w-6 rounded-md"
    testId={`slash-command-icon-${command.testId}`}
  />
)
interface ActiveComposerMenu {
  kind: ComposerTextTrigger['kind']
  trigger: ComposerTextTrigger
}
export function ComposerAutocompleteInput<Project = unknown, Conversation = unknown>({
  value,
  onChange,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  onSubmit,
  canSend,
  disabled,
  placeholder,
  testId = 'chat-message-input',
  rows,
  textareaRef,
  className,
  nativeEmptyCaret = false,
  skillMenuClassName = 'left-0 w-[min(28rem,calc(100vw-2rem))]',
  disableAutocomplete = false,
  onKeyDown,
  onPasteFiles,
  onOpenSkillFile,
  workspaceTarget,
  workspaceFileApi,
  cloudMentionCandidates = [],
  conversationMentionCandidates = [],
  externalMentionCandidates = [],
  mentionScope = 'all',
  cloudProjectCandidates = [],
  cloudSpaceEnabled = false,
  onSelectCloudProject,
  onSelectExternalMention,
  onListLocalSkills,
  onListLocalApps,
  models = [],
  selectedModel,
  selectedModelOptions = {},
  planModeActive = false,
  onSetPlanMode,
  onSetGoal,
  onSelectModel,
  onBlockedModelSelect,
  isModelSelectionReady = true,
  sendKey = 'enter',
  followUpBehavior = 'queue',
  isStreaming = false,
  ref,
  translate: t,
  appsStore: hostAppsStore,
  catalogEvents = EMPTY_EVENTS,
  compareApps,
  resolveAppLogo = noAppLogo,
  onSelectApp,
  onOpenMarketplace,
  renderAppIcon = defaultAppIcon,
  onOpenMentionPlugin,
  onPickWorkspacePaths,
  contributedMentionCandidates = [],
  contributedSlashCommands = [],
  onMentionQueryChange,
  onExecuteCommand,
  Bindings,
  debug,
  editorServices,
  transferServices,
}: ComposerAutocompleteInputProps<Project, Conversation>) {
  type ComposerMentionCandidate = Candidate<Project, Conversation>
  type MentionMenuRow = SharedMentionMenuRow<
    ComposerMentionCandidate,
    ComposerExternalMentionCandidate
  >
  const [ownAppsStore] = useState(() => createComposerCatalogStore<LocalDeviceApp>())
  const [actionError, setActionError] = useState<string | null>(null)
  const filterSlashCommands = useCallback(
    (commands: SlashCommand[], query: string, hasDraft: boolean) =>
      filterSharedSlashCommands(
        commands,
        query,
        hasDraft,
        compareApps ? (left, right) => compareApps(left.app!, right.app!) : undefined
      ),
    [compareApps]
  )
  const menuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<ComposerEditorHandle | null>(null)
  const focusRequestExpiresAtRef = useRef(0)
  const valueRef = useRef(value)

  const activeMenuRef = useRef<ActiveComposerMenu | null>(null)
  const highlightedIndexRef = useRef(0)
  const showSkillMenuRef = useRef(false)
  const showSlashMenuRef = useRef(false)
  const activeOptionCountRef = useRef(0)
  const [activeMenu, setActiveMenu] = useState<ActiveComposerMenu | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0)
  const isCatalogMenuOpen = useCallback(
    () => showSkillMenuRef.current || showSlashMenuRef.current,
    []
  )
  const { skills, apps, loading, loadError, appsLoading, appsLoadError, loadLocalMentions } =
    useComposerCatalog({
      onListLocalSkills,
      onListLocalApps,
      appsStore: hostAppsStore ?? ownAppsStore,
      events: catalogEvents,
      isMenuOpen: isCatalogMenuOpen,
    })
  const [cloudProjectsOpen, setCloudProjectsOpen] = useState(false)
  const canPickNativeWorkspacePaths = Boolean(onPickWorkspacePaths)

  useEffect(() => {
    valueRef.current = value
  }, [value])

  const { appCandidates, skillCandidates, mentionCandidates, filteredMentionCandidates } =
    useComposerMentionCandidates(
      apps,
      skills,
      selectedModel,
      activeMenu?.kind === 'skill' || activeMenu?.kind === 'mention'
        ? activeMenu.trigger.query
        : '',
      cloudMentionCandidates,
      conversationMentionCandidates,
      t,
      compareApps
    )
  const filteredSkillCandidates = useMemo(
    () =>
      filteredMentionCandidates.filter(
        candidate => candidate.kind === 'skill' || candidate.kind === 'app'
      ),
    [filteredMentionCandidates]
  )

  const filteredExternalMentionCandidates = useMemo(() => {
    if (activeMenu?.kind !== 'mention') return []
    const query = activeMenu.trigger.query.trim().toLocaleLowerCase()
    const candidates =
      mentionScope === 'external'
        ? externalMentionCandidates.filter(candidate =>
            (editorRef.current?.getSnapshot().value ?? value)[activeMenu.trigger.start] === '#'
              ? candidate.type === 'issue'
              : candidate.type !== 'issue'
          )
        : externalMentionCandidates
    if (!query) return candidates
    return candidates.filter(candidate =>
      [candidate.title, ...(candidate.searchAliases ?? [])].some(value =>
        value.toLocaleLowerCase().includes(query)
      )
    )
  }, [activeMenu, externalMentionCandidates, mentionScope, value])
  const mentionQuery = activeMenu?.kind === 'mention' ? activeMenu.trigger.query : ''
  useEffect(() => {
    onMentionQueryChange?.(mentionQuery)
  }, [mentionQuery, onMentionQueryChange])

  const workspaceSearch = useWorkspaceMentionSearch(
    activeMenu?.kind === 'mention' ? activeMenu.trigger.query : '',
    workspaceTarget,
    workspaceFileApi
  )

  // The `@项目空间:keyword` scope syntax drills straight into the cloud project
  // list without clicking the menu entry, matching the other mention flows.
  const cloudProjectScopeLabels = useMemo(
    () => [
      t('workbench.mention_cloud_project_space', '项目空间'),
      '项目空间',
      'project space',
      'project-space',
    ],
    [t]
  )
  const cloudProjectScopeLabelsRef = useRef(cloudProjectScopeLabels)
  useEffect(() => {
    cloudProjectScopeLabelsRef.current = cloudProjectScopeLabels
  }, [cloudProjectScopeLabels])
  const cloudProjectScopeKeyword =
    activeMenu?.kind === 'mention'
      ? parseCloudProjectScopeQuery(activeMenu.trigger.query, cloudProjectScopeLabels)
      : null
  const cloudProjectScopeActive = cloudSpaceEnabled && cloudProjectScopeKeyword !== null
  const filteredCloudProjectCandidates = useMemo(
    () =>
      cloudProjectScopeActive
        ? cloudProjectCandidates.filter(candidate =>
            matchesMentionQuery(candidate, cloudProjectScopeKeyword ?? '')
          )
        : cloudProjectCandidates,
    [cloudProjectCandidates, cloudProjectScopeActive, cloudProjectScopeKeyword]
  )
  // The direct cloud space reference inserted by the `项目空间` row. Selecting it
  // never binds a project; it just tags the message with the generic
  // `cloud://projects` capability reference.
  const cloudSpaceDirectReference = `[$${t('workbench.mention_cloud_project_space', '项目空间')}](cloud://projects)`

  const canOpenSlashModelMenu = isModelSelectionReady && Boolean(onSelectModel) && models.length > 0
  const openSlashModelMenu = useCallback(() => {
    setModelQuery('')
    setModelSelectedIndex(0)
    setModelMenuOpen(true)
  }, [])
  const closeSlashModelMenu = useCallback(
    (focusTextarea = false) => {
      setModelMenuOpen(false)
      setModelQuery('')
      setModelSelectedIndex(0)
      if (focusTextarea) {
        window.requestAnimationFrame(() => {
          textareaRef.current?.focus()
        })
      }
    },
    [textareaRef]
  )

  const actionSlashCommands = useMemo<SlashCommand[]>(
    () =>
      createComposerActionCommands({
        translate: (key, fallback) => t(key, fallback ?? key),
        planModeActive,
        onSetPlanMode,
        onSetGoal,
        onOpenModels: canOpenSlashModelMenu ? openSlashModelMenu : undefined,
      }),
    [canOpenSlashModelMenu, onSetGoal, onSetPlanMode, openSlashModelMenu, planModeActive, t]
  )

  const skillSlashCommands = useMemo<SlashCommand[]>(
    () => createSkillSlashCommands(skillCandidates, (key, fallback) => t(key, fallback ?? key)),
    [skillCandidates, t]
  )
  const pluginSlashCommands = useMemo<SlashCommand[]>(
    () =>
      createPluginSlashCommands(appCandidates, {
        translate: (key, fallback) => t(key, fallback ?? key),
        resolveLogo: resolveAppLogo,
        onOpenMarketplace,
      }),
    [appCandidates, resolveAppLogo, onOpenMarketplace, t]
  )

  const slashCommands = useMemo(
    () => [
      ...actionSlashCommands,
      ...contributedSlashCommands,
      ...pluginSlashCommands,
      ...skillSlashCommands,
    ],
    [actionSlashCommands, contributedSlashCommands, pluginSlashCommands, skillSlashCommands]
  )

  const filteredSlashCommands = useMemo(() => {
    if (activeMenu?.kind !== 'slash') return []
    return filterSlashCommands(
      slashCommands,
      activeMenu.trigger.query,
      hasDraftTextForSlashCommands(value)
    )
  }, [activeMenu, slashCommands, value, filterSlashCommands])

  const showSkillMenu =
    (activeMenu?.kind === 'skill' || activeMenu?.kind === 'mention') &&
    (activeMenu.kind === 'mention' || Boolean(onListLocalSkills) || Boolean(onListLocalApps))
  const showSlashMenu = activeMenu?.kind === 'slash'
  const mentionMenuRows = useMemo<MentionMenuRow[]>(
    () =>
      mentionScope === 'external'
        ? filteredExternalMentionCandidates.map(candidate => ({
            kind: 'external' as const,
            candidate,
          }))
        : createComposerMentionRows<ComposerMentionCandidate, ComposerExternalMentionCandidate>({
            open: showSkillMenu,
            mode: activeMenu?.kind,
            query: activeMenu?.trigger.query ?? '',
            skillCandidates: filteredSkillCandidates,
            candidates: filteredMentionCandidates,
            contributedCandidates: contributedMentionCandidates,
            externalCandidates: filteredExternalMentionCandidates,
            cloudProjectsOpen,
            cloudProjectScopeActive,
            cloudSpaceEnabled,
            cloudProjectCandidates,
            filteredCloudProjectCandidates,
            canSetGoal: Boolean(onSetGoal),
            canSetPlanMode: Boolean(onSetPlanMode),
            planModeActive,
            workspaceMatches: workspaceSearch.matches,
          }),
    [
      mentionScope,
      activeMenu,
      cloudProjectCandidates,
      cloudProjectScopeActive,
      cloudProjectsOpen,
      cloudSpaceEnabled,
      contributedMentionCandidates,
      filteredCloudProjectCandidates,
      filteredExternalMentionCandidates,
      filteredMentionCandidates,
      filteredSkillCandidates,
      onSetGoal,
      onSetPlanMode,
      planModeActive,
      showSkillMenu,
      workspaceSearch.matches,
    ]
  )
  const activeOptionCount = showSkillMenu
    ? mentionMenuRows.length
    : showSlashMenu
      ? filteredSlashCommands.length
      : 0
  const highlightedIndex = Math.min(selectedIndex, Math.max(activeOptionCount - 1, 0))
  const hasMentionCandidates = mentionCandidates.length > 0
  const hasMentionLoadError = !hasMentionCandidates && (loadError || appsLoadError)
  const isMentionLoading = !hasMentionCandidates && (loading || appsLoading)
  const hasMentionSlashCommands = skillSlashCommands.length + appCandidates.length > 0
  const hasSlashMentionLoadError =
    !hasMentionSlashCommands && ((Boolean(onListLocalSkills) && loadError) || appsLoadError)
  const isSlashMentionLoading =
    !hasMentionSlashCommands && ((Boolean(onListLocalSkills) && loading) || appsLoading)

  useLayoutEffect(() => {
    activeMenuRef.current = activeMenu
    highlightedIndexRef.current = highlightedIndex
    showSkillMenuRef.current = showSkillMenu
    showSlashMenuRef.current = showSlashMenu
    activeOptionCountRef.current = activeOptionCount
  }, [activeMenu, activeOptionCount, highlightedIndex, showSkillMenu, showSlashMenu])

  useEffect(() => {
    if (!showSkillMenu && !showSlashMenu) return
    const selectedOption = menuRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]'
    )
    selectedOption?.scrollIntoView?.({ block: 'nearest' })
  }, [activeOptionCount, highlightedIndex, showSkillMenu, showSlashMenu])

  const closeAutocompleteMenu = useCallback(() => {
    setActiveMenu(null)
    setSelectedIndex(0)
    highlightedIndexRef.current = 0
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return editorRef.current?.element ?? null
      },
      focus: () => {
        focusRequestExpiresAtRef.current = Date.now() + 2_000
        editorRef.current?.focus()
      },
      getValue: () => editorRef.current?.getSnapshot().value ?? valueRef.current,
      insertReference: reference => {
        const editor = editorRef.current
        if (!editor) return
        const next = insertComposerReference(editor.getSnapshot(), reference)
        valueRef.current = next.value
        editor.setValue(next.value, next.cursor)
        closeAutocompleteMenu()
        if (mentionScope === 'external' && /(?:^|\s)[@#]$/.test(reference)) {
          const symbol = reference.endsWith('#') ? '#' : '@'
          const trigger = findStandaloneTrigger(next.value, next.cursor, symbol, 'mention')
          if (trigger) setActiveMenu({ kind: 'mention', trigger })
        }
      },
      setValue: (nextValue, selectionOffset = nextValue.length) => {
        valueRef.current = nextValue
        editorRef.current?.setValue(nextValue, selectionOffset)
      },
    }),
    [closeAutocompleteMenu, mentionScope]
  )

  const moveHighlightedIndex = useCallback((delta: number) => {
    const optionCount = activeOptionCountRef.current
    if (optionCount <= 0) return false

    setSelectedIndex(currentIndex => {
      const current = Math.min(currentIndex, optionCount - 1)
      const nextIndex = Math.max(0, Math.min(current + delta, optionCount - 1))
      highlightedIndexRef.current = nextIndex
      return nextIndex
    })
    return true
  }, [])

  const updateAutocompleteTrigger = useCallback(
    (snapshot?: ComposerEditorSnapshot) => {
      if (disableAutocomplete) return
      const editor = editorRef.current
      const current = snapshot ?? editor?.getSnapshot()
      if (!current) return

      const { nextTrigger: resolvedTrigger, triggerUnchanged } = resolveComposerAutocompleteTrigger(
        current,
        activeMenuRef.current,
        Boolean(onListLocalSkills),
        cloudProjectScopeLabelsRef.current,
        mentionScope === 'external'
      )
      const nextTrigger =
        mentionScope === 'external' && resolvedTrigger?.kind !== 'mention' ? null : resolvedTrigger

      startTransition(() => {
        setActiveMenu(nextTrigger ? { kind: nextTrigger.kind, trigger: nextTrigger } : null)
        if (nextTrigger) {
          setModelMenuOpen(false)
          if (!triggerUnchanged) {
            setSelectedIndex(0)
            highlightedIndexRef.current = 0
            setCloudProjectsOpen(false)
          }
        }
      })
      if (
        mentionScope === 'all' &&
        nextTrigger &&
        (nextTrigger.kind === 'skill' ||
          nextTrigger.kind === 'mention' ||
          onListLocalSkills ||
          onListLocalApps)
      ) {
        loadLocalMentions()
      }
    },
    [loadLocalMentions, onListLocalApps, onListLocalSkills, disableAutocomplete, mentionScope]
  )

  const commitEditorValue = useCallback(
    (nextValue: string, nextCursor: number) => {
      const editor = editorRef.current
      valueRef.current = nextValue
      if (editor) {
        editor.setValue(nextValue, nextCursor)
      } else {
        onChange(nextValue)
      }
      // A later edit may open another picker before this frame runs.
      window.requestAnimationFrame(() => updateAutocompleteTrigger())
    },
    [onChange, updateAutocompleteTrigger]
  )

  const selectMentionCandidate = useCallback(
    (candidate: ComposerMentionCandidate, explicitTrigger?: ComposerTextTrigger | null) => {
      const trigger = explicitTrigger ?? activeMenuRef.current?.trigger
      const editor = editorRef.current
      if (!trigger || !editor) return false

      const snapshot = editor.getSnapshot()
      if (candidate.kind === 'app') {
        const logo = resolveAppLogo(candidate.app)
        if (logo.source === 'provided' && logo.url) {
          registerComposerMentionIcon(candidate.reference, {
            url: logo.url,
            contrastPad: logo.contrastPad,
          })
        }
      }
      const triggerEnd = trigger.start + 1 + trigger.query.length
      const replacement = replaceComposerMentionTrigger(
        snapshot.value,
        candidate.reference,
        trigger.start,
        Math.max(snapshot.selectionEnd, triggerEnd)
      )

      commitEditorValue(replacement.value, replacement.cursor)
      if (candidate.kind === 'app') {
        onSelectApp?.(candidate.title, candidate.app)
      }
      closeAutocompleteMenu()
      textareaRef.current?.focus()
      editor.focus()
      return true
    },
    [resolveAppLogo, onSelectApp, closeAutocompleteMenu, commitEditorValue, textareaRef]
  )

  const selectSkill = useCallback(
    (skill: LocalDeviceSkill, explicitTrigger?: ComposerTextTrigger | null) => {
      const skillCandidate = skillCandidates.find(candidate => candidate.skill.name === skill.name)
      return skillCandidate ? selectMentionCandidate(skillCandidate, explicitTrigger) : false
    },
    [selectMentionCandidate, skillCandidates]
  )

  const selectSlashCommand = useCallback(
    (command: SlashCommand, explicitTrigger?: ComposerTextTrigger | null) => {
      setActionError(null)
      if (command.skill) return selectSkill(command.skill, explicitTrigger)
      if (command.app) {
        const appCandidate = appCandidates.find(candidate => candidate.app.id === command.app?.id)
        return appCandidate ? selectMentionCandidate(appCandidate, explicitTrigger) : false
      }

      const trigger =
        explicitTrigger ??
        (activeMenuRef.current?.kind === 'slash' ? activeMenuRef.current.trigger : null)
      const editor = editorRef.current
      if (!trigger || !editor) return false

      const snapshot = editor.getSnapshot()
      const nextValue =
        snapshot.value.slice(0, trigger.start) + snapshot.value.slice(snapshot.selectionEnd)
      const nextCursor = trigger.start

      commitEditorValue(nextValue, nextCursor)
      closeAutocompleteMenu()
      if (command.extensionCommand) {
        const composer = {
          focus: () => editor.focus(),
          getValue: () => editor.getSnapshot().value,
          insertText: (text: string) => {
            const current = editor.getSnapshot()
            const inserted =
              current.value.slice(0, current.selectionStart) +
              text +
              current.value.slice(current.selectionEnd)
            commitEditorValue(inserted, current.selectionStart + text.length)
            editor.focus()
          },
          setValue: (next: string, selectionOffset = next.length) => {
            commitEditorValue(next, selectionOffset)
            editor.focus()
          },
        }
        void onExecuteCommand?.(command.extensionCommand, composer).catch(error => {
          setActionError(error instanceof Error ? error.message : String(error))
        })
      } else {
        command.onSelect?.()
      }
      textareaRef.current?.focus()
      editor.focus()
      return true
    },
    [
      appCandidates,
      closeAutocompleteMenu,
      commitEditorValue,
      selectMentionCandidate,
      selectSkill,
      onExecuteCommand,
      textareaRef,
    ]
  )

  const selectMentionMenuRow = useCallback(
    (row: MentionMenuRow, explicitTrigger?: ComposerTextTrigger) => {
      if (row.kind === 'files-action' && !onPickWorkspacePaths) return false
      const trigger = explicitTrigger ?? activeMenuRef.current?.trigger
      const editor = editorRef.current
      if (!trigger || !editor) return false
      if (row.kind === 'candidate') {
        if (!row.candidate.enabled) return false
        const selected = selectMentionCandidate(row.candidate, trigger)
        if (selected && row.candidate.kind === 'cloud' && row.candidate.project) {
          onSelectCloudProject?.(row.candidate.project)
        }
        return selected
      }
      if (row.kind === 'external') {
        if (row.candidate.reference) {
          const snapshot = editor.getSnapshot()
          const replacement = replaceComposerMentionTrigger(
            snapshot.value,
            row.candidate.reference,
            trigger.start,
            Math.max(snapshot.selectionEnd, trigger.start + 1 + trigger.query.length)
          )
          commitEditorValue(replacement.value, replacement.cursor)
        }
        onSelectExternalMention?.(row.candidate)
        closeAutocompleteMenu()
        return true
      }
      if (row.kind === 'cloud-projects-action') {
        setCloudProjectsOpen(true)
        setSelectedIndex(0)
        highlightedIndexRef.current = 0
        return true
      }
      if (row.kind === 'cloud-back-action') {
        setCloudProjectsOpen(false)
        setSelectedIndex(0)
        highlightedIndexRef.current = 0
        return true
      }

      const snapshot = editor.getSnapshot()
      if (row.kind === 'cloud-space-direct-action') {
        const replacement = replaceComposerMentionTrigger(
          snapshot.value,
          cloudSpaceDirectReference,
          trigger.start,
          snapshot.selectionEnd
        )
        commitEditorValue(replacement.value, replacement.cursor)
        closeAutocompleteMenu()
        editor.focus()
        return true
      }
      if (row.kind === 'path') {
        const path = resolveComposerWorkspacePath(row.item.root, row.item.path)
        const reference = createComposerPathReference(path, row.item.matchType === 'directory')
        const replacement = replaceComposerMentionTrigger(
          snapshot.value,
          reference,
          trigger.start,
          snapshot.selectionEnd
        )
        commitEditorValue(replacement.value, replacement.cursor)
        closeAutocompleteMenu()
        editor.focus()
        return true
      }

      const nextValue =
        snapshot.value.slice(0, trigger.start) + snapshot.value.slice(snapshot.selectionEnd)
      commitEditorValue(nextValue, trigger.start)
      closeAutocompleteMenu()
      if (row.kind === 'goal-action') onSetGoal?.()
      if (row.kind === 'plan-action') onSetPlanMode?.()
      if (row.kind === 'files-action' && onPickWorkspacePaths) {
        setActionError(null)
        void onPickWorkspacePaths(workspaceTarget?.path)
          .then(entries => {
            if (entries.length === 0) return
            const currentEditor = editorRef.current
            if (!currentEditor) return
            const references = entries
              .map(entry => createComposerPathReference(entry.path, entry.isDirectory))
              .join(' ')
            const current = currentEditor.getSnapshot()
            const spacer = current.value && current.selectionOffset > 0 ? ' ' : ''
            const nextValue =
              current.value.slice(0, current.selectionOffset) +
              spacer +
              references +
              ' ' +
              current.value.slice(current.selectionOffset)
            commitEditorValue(
              nextValue,
              current.selectionOffset + spacer.length + references.length + 1
            )
            currentEditor.focus()
          })
          .catch(error => {
            setActionError(error instanceof Error ? error.message : String(error))
          })
      }
      editor.focus()
      return true
    },
    [
      closeAutocompleteMenu,
      cloudSpaceDirectReference,
      commitEditorValue,
      onSelectCloudProject,
      onSelectExternalMention,
      onSetGoal,
      onSetPlanMode,
      selectMentionCandidate,
      workspaceTarget?.path,
      onPickWorkspacePaths,
    ]
  )

  const selectHighlightedMention = useCallback(() => {
    const row = mentionMenuRows[highlightedIndexRef.current]
    return row ? selectMentionMenuRow(row) : false
  }, [mentionMenuRows, selectMentionMenuRow])

  const handleMentionRowClick = useCallback(
    (index: number) => {
      const row = mentionMenuRows[index]
      if (!row) return
      setSelectedIndex(index)
      selectMentionMenuRow(row, activeMenu?.trigger)
    },
    [activeMenu?.trigger, mentionMenuRows, selectMentionMenuRow]
  )

  const selectHighlightedSlashCommand = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return false
    const snapshot = editor.getSnapshot()
    const currentSlashTrigger = findStandaloneTrigger(
      snapshot.value,
      snapshot.selectionOffset,
      '/',
      'slash'
    )
    const commands = currentSlashTrigger
      ? filterSlashCommands(
          slashCommands,
          currentSlashTrigger.query,
          hasDraftTextForSlashCommands(snapshot.value)
        )
      : filteredSlashCommands
    const command = commands[highlightedIndexRef.current] ?? commands[0]
    if (!command || command.enabled === false) return false
    return selectSlashCommand(command, currentSlashTrigger)
  }, [filteredSlashCommands, selectSlashCommand, slashCommands, filterSlashCommands])

  const confirmHighlightedMenuSelection = useCallback(() => {
    if (showSkillMenuRef.current) return selectHighlightedMention()
    if (showSlashMenuRef.current) return selectHighlightedSlashCommand()
    return false
  }, [selectHighlightedMention, selectHighlightedSlashCommand])

  const getModelCompatibilityDisabledMessage = useCallback(
    (model: UnifiedModel) =>
      model.compatibilityDisabled
        ? modelCompatibilityDisabledMessage(model.compatibilityDisabledReason, (key, fallback) =>
            t(key, fallback)
          )
        : undefined,
    [t]
  )

  const selectSlashModel = useCallback(
    (model: UnifiedModel) => {
      onSelectModel?.(model)
      closeSlashModelMenu(true)
    },
    [closeSlashModelMenu, onSelectModel]
  )

  const outsideClickExceptions = useMemo(() => [textareaRef], [textareaRef])
  useOutsideClick(
    menuRef,
    showSkillMenu || showSlashMenu,
    closeAutocompleteMenu,
    outsideClickExceptions
  )
  useOutsideClick(modelMenuRef, modelMenuOpen, closeSlashModelMenu, outsideClickExceptions)

  const {
    handleCompositionStart,
    handleCompositionEnd,
    handleKeyUp,
    handleBlur,
    handleEditorSnapshot,
    handleEditorBeforeInput,
    handleEditorKeyDown,
  } = useComposerInputEvents({
    editorRef,
    valueRef,
    onSubmit,
    canSend,
    sendKey,
    isStreaming,
    followUpBehavior,
    onKeyDown,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    onKeyUp: updateAutocompleteTrigger,
    onSnapshotChange: updateAutocompleteTrigger,
    debug,
    autocomplete: {
      isOpen: () => showSkillMenuRef.current || showSlashMenuRef.current,
      optionCount: () => activeOptionCountRef.current,
      move: moveHighlightedIndex,
      close: closeAutocompleteMenu,
      confirm: confirmHighlightedMenuSelection,
      debugDetails: () => ({
        showSkillMenu: showSkillMenuRef.current,
        showSlashMenu: showSlashMenuRef.current,
        highlightedIndex: highlightedIndexRef.current,
        activeOptionCount: activeOptionCountRef.current,
      }),
    },
  })

  const {
    editingLink,
    editingLinkAnchor,
    editComposerLink,
    closeComposerLink,
    changeComposerLink,
    removeComposerLink,
  } = useComposerLinkEditing(editorRef, commitEditorValue)

  const { handlePaste, handleDrop, transferError } = useComposerTransfers({
    editorRef,
    commitEditorValue,
    disabled,
    onPasteFiles,
    services: transferServices,
  })

  return (
    <div className="relative min-w-0 flex-1 w-full">
      <ComposerErrorBanner error={transferError || actionError} />
      {Bindings && (
        <Bindings
          value={value}
          valueRef={valueRef}
          editorRef={editorRef}
          textareaRef={textareaRef}
          commitEditorValue={commitEditorValue}
          closeAutocompleteMenu={closeAutocompleteMenu}
        />
      )}
      <ComposerProseMirrorEditor
        key="composer-editor-multiline-paste-v3"
        ref={editorRef}
        value={value}
        onChange={nextValue => {
          valueRef.current = nextValue
          onChange(nextValue)
        }}
        onSnapshotChange={handleEditorSnapshot}
        onKeyDown={handleEditorKeyDown}
        onBeforeInput={handleEditorBeforeInput}
        onKeyUp={handleKeyUp}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onBlur={handleBlur}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onOpenMentionFile={onOpenSkillFile}
        onOpenMentionPlugin={onOpenMentionPlugin}
        onEditComposerLink={editComposerLink}
        onClick={() => updateAutocompleteTrigger()}
        onFocus={() => updateAutocompleteTrigger()}
        onReady={() => {
          if (focusRequestExpiresAtRef.current >= Date.now()) {
            editorRef.current?.focus()
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        testId={testId}
        rows={rows}
        textareaRef={textareaRef}
        className={className}
        services={editorServices}
        nativeEmptyCaret={nativeEmptyCaret}
      />
      {showSkillMenu && (
        <ComposerMentionMenu
          translate={t}
          menuRef={menuRef}
          rows={mentionMenuRows}
          selectedIndex={highlightedIndex}
          className={skillMenuClassName}
          mentionMode={activeMenu?.kind === 'mention'}
          projectSpaceScope={cloudProjectsOpen || cloudProjectScopeActive}
          loading={isMentionLoading || workspaceSearch.loading}
          error={hasMentionLoadError || workspaceSearch.error}
          canBrowseFiles={canPickNativeWorkspacePaths}
          onRetry={() => {
            workspaceSearch.retry()
            loadLocalMentions({ force: true })
          }}
          onHighlight={setSelectedIndex}
          onSelect={handleMentionRowClick}
        />
      )}
      {showSlashMenu && (
        <div ref={menuRef}>
          <SlashCommandMenu
            renderAppIcon={renderAppIcon}
            commands={filteredSlashCommands}
            selectedIndex={highlightedIndex}
            className={skillMenuClassName}
            title={t('workbench.slash_command_menu_title')}
            noResultsLabel={t('workbench.no_slash_commands')}
            loadingSkills={isSlashMentionLoading}
            skillLoadError={hasSlashMentionLoadError}
            skillGroupLabel={t('workbench.slash_command_group_skills')}
            skillLoadingLabel={t('workbench.loading_slash_command_skills')}
            skillLoadErrorLabel={t('workbench.slash_command_skills_error')}
            skillRetryLabel={t('workbench.retry_local_skills')}
            onSelectCommand={command => selectSlashCommand(command, activeMenu?.trigger)}
            onHighlightCommand={setSelectedIndex}
            onRetrySkills={() => loadLocalMentions({ force: true })}
          />
        </div>
      )}
      {modelMenuOpen && (
        <div ref={modelMenuRef}>
          <SlashModelMenu
            translate={t}
            models={models}
            selectedModel={selectedModel ?? null}
            selectedModelOptions={selectedModelOptions}
            query={modelQuery}
            selectedIndex={modelSelectedIndex}
            className={skillMenuClassName}
            searchPlaceholder={t('workbench.search_models')}
            noResultsLabel={t('workbench.no_models')}
            onQueryChange={setModelQuery}
            onSelectedIndexChange={setModelSelectedIndex}
            onSelectModel={selectSlashModel}
            onBlockedModelSelect={onBlockedModelSelect}
            onClose={() => closeSlashModelMenu(true)}
            getCompatibilityDisabledMessage={getModelCompatibilityDisabledMessage}
          />
        </div>
      )}
      {editingLink && (
        <LinkEditPopover
          key={`${editingLink.url}-${editingLink.label}`}
          payload={{ url: editingLink.url, label: editingLink.label }}
          anchor={editingLinkAnchor}
          onClose={closeComposerLink}
          onChange={changeComposerLink}
          onRemove={removeComposerLink}
        />
      )}
    </div>
  )
}
