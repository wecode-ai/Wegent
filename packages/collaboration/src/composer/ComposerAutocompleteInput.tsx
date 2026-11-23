import { insertComposerReference } from './insertComposerReference'
import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  useSyncExternalStore,
} from 'react'
import { ComposerPredictionStatus } from './ComposerPredictionStatus'
import { ComposerPredictionContext } from './ComposerPredictionContext'
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
import { ComposerAutocompletePopup } from './ComposerAutocompletePopup'
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
import { registerComposerMentionIcon, replaceComposerMentionTrigger } from './composerMentions'
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
import {
  createComposerAutocompleteState,
  createComposerEditorValuePort,
} from './composerAutocompleteState'
import { selectComposerMentionRow } from './selectComposerMentionRow'
import { useScrollRequest } from '../dom-events'
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
  predictionStatusTarget,
  rows,
  textareaRef,
  className,
  scrollContainerClassName,
  nativeEmptyCaret = false,
  skillMenuClassName = 'w-[min(28rem,calc(100vw-2rem))]',
  slashMenuClassName = skillMenuClassName,
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
  onActivateMention,
  onListLocalSkills,
  onListLocalApps,
  models = [],
  selectedModel,
  selectedModelOptions = {},
  planModeActive = false,
  onSetPlanMode,
  onSetGoal,
  onDraw,
  onSelectModel,
  onOpenModelSelector,
  modelSelectorOpen = false,
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
  onOpenMentionReference,
  onPickWorkspacePaths,
  contributedMentionCandidates = [],
  contributedSlashCommands = [],
  autocompleteState: hostAutocompleteState,
  onExecuteCommand,
  Bindings,
  debug,
  editorServices,
  transferServices,
}: ComposerAutocompleteInputProps<Project, Conversation>) {
  const prediction = useContext(ComposerPredictionContext)
  const [ownAutocompleteState] = useState(() => createComposerAutocompleteState(value))
  const autocompleteState = hostAutocompleteState ?? ownAutocompleteState
  const menuState = useSyncExternalStore(
    autocompleteState.subscribe,
    autocompleteState.getSnapshot,
    autocompleteState.getSnapshot
  )
  const hasDraft = Boolean(menuState.editorValue.trim())
  const {
    activeMenu,
    selectedIndex,
    modelMenuOpen,
    modelQuery,
    modelSelectedIndex,
    cloudProjectsOpen,
  } = menuState
  const {
    setActiveMenu,
    setSelectedIndex,
    setModelMenuOpen,
    setModelQuery,
    setModelSelectedIndex,
    setCloudProjectsOpen,
  } = autocompleteState
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
  const [popupAnchor, setPopupAnchor] = useState<HTMLDivElement | null>(null)
  const editorRef = useRef<ComposerEditorHandle | null>(null)
  const valueRef = useMemo(
    () => createComposerEditorValuePort(editorRef, autocompleteState),
    [autocompleteState]
  )
  const isCatalogMenuOpen = useCallback(() => {
    const active = autocompleteState.getSnapshot().activeMenu
    return (
      active?.kind === 'slash' ||
      active?.kind === 'mention' ||
      (active?.kind === 'skill' && Boolean(onListLocalSkills || onListLocalApps))
    )
  }, [autocompleteState, onListLocalSkills, onListLocalApps])
  const { skills, apps, loading, loadError, appsLoading, appsLoadError, loadLocalMentions } =
    useComposerCatalog({
      onListLocalSkills,
      onListLocalApps,
      appsStore: hostAppsStore ?? ownAppsStore,
      events: catalogEvents,
      isMenuOpen: isCatalogMenuOpen,
    })
  const canPickNativeWorkspacePaths = Boolean(onPickWorkspacePaths && onPasteFiles)

  const { appCandidates, skillCandidates, mentionCandidates, filteredMentionCandidates } =
    useComposerMentionCandidates(
      apps,
      skills,
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
            activeMenu.symbol === '#' ? candidate.type === 'issue' : candidate.type !== 'issue'
          )
        : externalMentionCandidates
    if (!query) return candidates
    return candidates.filter(candidate =>
      [candidate.title, ...(candidate.searchAliases ?? [])].some(value =>
        value.toLocaleLowerCase().includes(query)
      )
    )
  }, [activeMenu, externalMentionCandidates, mentionScope])

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

  const canOpenSlashModelMenu =
    isModelSelectionReady && Boolean(onOpenModelSelector || (onSelectModel && models.length > 0))
  const openSlashModelMenu = useCallback(() => {
    if (onOpenModelSelector) {
      onOpenModelSelector()
      return
    }
    setModelQuery('')
    setModelSelectedIndex(0)
    setModelMenuOpen(true)
  }, [onOpenModelSelector, setModelMenuOpen, setModelQuery, setModelSelectedIndex])
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
    [textareaRef, setModelMenuOpen, setModelQuery, setModelSelectedIndex]
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
            canDraw: Boolean(onDraw),
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
      onDraw,
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

  useScrollRequest(
    menuRef,
    '[role="option"][aria-selected="true"]',
    `${activeOptionCount}:${highlightedIndex}:${showSkillMenu}:${showSlashMenu}`,
    { enabled: showSkillMenu || showSlashMenu }
  )
  const closeAutocompleteMenu = autocompleteState.close

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return editorRef.current?.element ?? null
      },
      focus: () => {
        autocompleteState.requestFocus()
        editorRef.current?.focus()
      },
      getValue: () => editorRef.current?.getSnapshot().value ?? valueRef.current,
      captureInsertion: () => editorRef.current?.captureInsertion() ?? null,
      insertReference: reference => {
        const editor = editorRef.current
        if (!editor) return
        const next = insertComposerReference(editor.getSnapshot(), reference)
        editor.setValue(next.value, next.cursor)
        closeAutocompleteMenu()
        if (mentionScope === 'external' && /(?:^|\s)[@#]$/.test(reference)) {
          const symbol = reference.endsWith('#') ? '#' : '@'
          const trigger = findStandaloneTrigger(next.value, next.cursor, symbol, 'mention')
          if (trigger) setActiveMenu({ kind: 'mention', trigger, symbol })
        }
      },
      setValue: (nextValue, selectionOffset = nextValue.length) => {
        autocompleteState.restoreValue(nextValue)
        editorRef.current?.setValue(nextValue, selectionOffset)
      },
    }),
    [autocompleteState, closeAutocompleteMenu, mentionScope, setActiveMenu, valueRef]
  )

  const moveHighlightedIndex = useCallback(
    (delta: number) => {
      if (activeOptionCount <= 0) return false
      setSelectedIndex(currentIndex =>
        Math.max(
          0,
          Math.min(Math.min(currentIndex, activeOptionCount - 1) + delta, activeOptionCount - 1)
        )
      )
      return true
    },
    [activeOptionCount, setSelectedIndex]
  )

  const updateAutocompleteTrigger = useCallback(
    (snapshot?: ComposerEditorSnapshot) => {
      const editor = editorRef.current
      const current = snapshot ?? editor?.getSnapshot()
      if (!current) return
      autocompleteState.setEditorValue(editor?.element ? editor.getSnapshot().value : current.value)
      if (disableAutocomplete) return
      if (autocompleteState.isRestored(current.value)) return
      autocompleteState.clearRestoredValue()

      const { nextTrigger: resolvedTrigger, triggerUnchanged } = resolveComposerAutocompleteTrigger(
        current,
        autocompleteState.getSnapshot().activeMenu,
        Boolean(onListLocalSkills),
        cloudProjectScopeLabels,
        mentionScope === 'external'
      )
      const nextTrigger =
        mentionScope === 'external' && resolvedTrigger?.kind !== 'mention' ? null : resolvedTrigger

      setActiveMenu(
        nextTrigger
          ? {
              kind: nextTrigger.kind,
              trigger: nextTrigger,
              symbol: current.value[nextTrigger.start],
            }
          : null
      )
      if (nextTrigger) {
        setModelMenuOpen(false)
        if (!triggerUnchanged) {
          setSelectedIndex(0)
          setCloudProjectsOpen(false)
        }
      }
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
    [
      loadLocalMentions,
      onListLocalApps,
      onListLocalSkills,
      disableAutocomplete,
      mentionScope,
      autocompleteState,
      cloudProjectScopeLabels,
      setActiveMenu,
      setCloudProjectsOpen,
      setModelMenuOpen,
      setSelectedIndex,
    ]
  )

  const commitEditorValue = useCallback(
    (nextValue: string, nextCursor: number) => {
      const editor = editorRef.current
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
      const trigger = explicitTrigger ?? autocompleteState.getSnapshot().activeMenu?.trigger
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
    [
      resolveAppLogo,
      onSelectApp,
      closeAutocompleteMenu,
      commitEditorValue,
      textareaRef,
      autocompleteState,
    ]
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

      const currentMenu = autocompleteState.getSnapshot().activeMenu
      const trigger =
        explicitTrigger ?? (currentMenu?.kind === 'slash' ? currentMenu.trigger : null)
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
      autocompleteState,
    ]
  )

  const selectMentionMenuRow = useCallback(
    (row: MentionMenuRow, explicitTrigger?: ComposerTextTrigger) =>
      selectComposerMentionRow(row, explicitTrigger, {
        editorRef,
        autocompleteState,
        canPickNativeWorkspacePaths,
        closeAutocompleteMenu,
        cloudSpaceDirectReference,
        commitEditorValue,
        onSelectCloudProject,
        onSelectExternalMention,
        onSetGoal,
        onSetPlanMode,
        onDraw,
        selectMentionCandidate,
        workspaceTarget,
        onPickWorkspacePaths,
        onPasteFiles,
        setActionError,
      }),
    [
      canPickNativeWorkspacePaths,
      closeAutocompleteMenu,
      cloudSpaceDirectReference,
      commitEditorValue,
      onSelectCloudProject,
      onSelectExternalMention,
      onSetGoal,
      onSetPlanMode,
      onDraw,
      selectMentionCandidate,
      workspaceTarget,
      onPickWorkspacePaths,
      onPasteFiles,
      autocompleteState,
    ]
  )

  const selectHighlightedMention = useCallback(() => {
    const row =
      mentionMenuRows[
        Math.min(autocompleteState.getSnapshot().selectedIndex, Math.max(activeOptionCount - 1, 0))
      ]
    return row ? selectMentionMenuRow(row) : false
  }, [mentionMenuRows, selectMentionMenuRow, activeOptionCount, autocompleteState])

  const handleMentionRowClick = useCallback(
    (index: number) => {
      const row = mentionMenuRows[index]
      if (!row) return
      setSelectedIndex(index)
      selectMentionMenuRow(row, activeMenu?.trigger)
    },
    [activeMenu?.trigger, mentionMenuRows, selectMentionMenuRow, setSelectedIndex]
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
    const command =
      commands[
        Math.min(autocompleteState.getSnapshot().selectedIndex, Math.max(activeOptionCount - 1, 0))
      ] ?? commands[0]
    if (!command || command.enabled === false) return false
    return selectSlashCommand(command, currentSlashTrigger)
  }, [
    filteredSlashCommands,
    selectSlashCommand,
    slashCommands,
    filterSlashCommands,
    activeOptionCount,
    autocompleteState,
  ])

  const confirmHighlightedMenuSelection = useCallback(() => {
    if (showSkillMenu) return selectHighlightedMention()
    if (showSlashMenu) return selectHighlightedSlashCommand()
    return false
  }, [selectHighlightedMention, selectHighlightedSlashCommand, showSkillMenu, showSlashMenu])

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
    onKeyUp: () => {
      autocompleteState.clearRestoredValue()
      updateAutocompleteTrigger()
    },
    onSnapshotChange: updateAutocompleteTrigger,
    debug,
    autocomplete: {
      isOpen: () => showSkillMenu || showSlashMenu,
      optionCount: () => activeOptionCount,
      move: moveHighlightedIndex,
      close: closeAutocompleteMenu,
      confirm: confirmHighlightedMenuSelection,
      debugDetails: () => ({
        showSkillMenu: showSkillMenu,
        showSlashMenu: showSlashMenu,
        highlightedIndex: Math.min(
          autocompleteState.getSnapshot().selectedIndex,
          Math.max(activeOptionCount - 1, 0)
        ),
        activeOptionCount: activeOptionCount,
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

  const predictionHidden =
    hasDraft ||
    disabled ||
    isStreaming ||
    showSkillMenu ||
    showSlashMenu ||
    modelMenuOpen ||
    modelSelectorOpen

  return (
    <div ref={setPopupAnchor} className="relative min-w-0 flex-1 w-full">
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
          autocompleteState.setEditorValue(nextValue)
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
        onActivateMention={onActivateMention}
        onOpenMentionReference={onOpenMentionReference}
        onEditComposerLink={editComposerLink}
        onClick={() => {
          autocompleteState.clearRestoredValue()
          updateAutocompleteTrigger()
        }}
        onFocus={() => updateAutocompleteTrigger()}
        onReady={() => {
          if (autocompleteState.shouldFocusWhenReady()) {
            editorRef.current?.focus()
          }
        }}
        disabled={disabled}
        prediction={predictionHidden ? null : prediction}
        placeholder={placeholder}
        testId={testId}
        rows={rows}
        textareaRef={textareaRef}
        className={className}
        scrollContainerClassName={scrollContainerClassName}
        services={editorServices}
        nativeEmptyCaret={nativeEmptyCaret}
      />
      <ComposerPredictionStatus
        target={predictionStatusTarget}
        hidden={predictionHidden}
        testId={testId}
        onAccept={text => {
          editorRef.current?.setValue(text)
          editorRef.current?.focus()
        }}
      />
      {(showSkillMenu || showSlashMenu || modelMenuOpen) && (
        <ComposerAutocompletePopup
          anchor={popupAnchor}
          editorRef={textareaRef}
          label={
            modelMenuOpen ? t('workbench.search_models') : t('workbench.slash_command_menu_title')
          }
          className={showSlashMenu && !modelMenuOpen ? slashMenuClassName : skillMenuClassName}
          onClose={restoreEditor => {
            if (modelMenuOpen) closeSlashModelMenu(restoreEditor)
            else closeAutocompleteMenu()
          }}
        >
          {showSkillMenu && (
            <ComposerMentionMenu
              translate={t}
              menuRef={menuRef}
              rows={mentionMenuRows}
              selectedIndex={highlightedIndex}
              className=""
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
                className=""
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
            <>
              <SlashModelMenu
                translate={t}
                models={models}
                selectedModel={selectedModel ?? null}
                selectedModelOptions={selectedModelOptions}
                query={modelQuery}
                selectedIndex={modelSelectedIndex}
                className=""
                searchPlaceholder={t('workbench.search_models')}
                noResultsLabel={t('workbench.no_models')}
                onQueryChange={setModelQuery}
                onSelectedIndexChange={setModelSelectedIndex}
                onSelectModel={selectSlashModel}
                onBlockedModelSelect={onBlockedModelSelect}
                onClose={() => closeSlashModelMenu(true)}
                getCompatibilityDisabledMessage={getModelCompatibilityDisabledMessage}
              />
            </>
          )}
        </ComposerAutocompletePopup>
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
