import { ClipboardList, Cpu, Package, Plug, Target } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT } from '@/features/plugins/pluginTrial'
import { isImeComposingEvent, isImeEnterEvent } from '@/lib/ime'
import {
  canOpenNativeWorkspacePathPicker,
  openNativeWorkspacePathPicker,
} from '@/lib/native-workspace-path-picker'
import type { LocalDeviceApp, LocalDeviceSkill, UnifiedModel } from '@/types/api'
import {
  ComposerProseMirrorEditor,
  type ComposerEditorHandle,
  type ComposerEditorSnapshot,
} from './ComposerProseMirrorEditor'
import type { ComposerTextTrigger, SlashCommand } from './composerAutocomplete'
import {
  chooseNearestTrigger,
  filterSlashCommands,
  findStandaloneTrigger,
  hasDraftTextForSlashCommands,
} from './composerAutocomplete'
import {
  slashAppTestId,
  slashSkillTestId,
  type ComposerMentionCandidate,
} from './composerMentionCandidates'
import {
  createComposerPathReference,
  findComposerMentionDeletionRange,
  replaceComposerMentionTrigger,
  resolveComposerWorkspacePath,
} from './composerMentions'
import { createLongPastedTextAttachment } from './pastedTextAttachment'
import { SlashCommandMenu } from './SlashCommandMenu'
import { SlashModelMenu } from './SlashModelMenu'
import { debugComposerEvent, textMetrics } from './composerDebug'
import { ComposerMentionMenu, type MentionMenuRow } from './ComposerMentionMenu'
import { useWorkspaceMentionSearch } from './useWorkspaceMentionSearch'
import { useComposerMentionCandidates } from './useComposerMentionCandidates'
import type { ComposerTextareaProps } from './composerTextareaTypes'

export type { ComposerSubmitOptions } from './composerTextareaTypes'

interface ActiveComposerMenu {
  kind: ComposerTextTrigger['kind']
  trigger: ComposerTextTrigger
}

export function ComposerTextarea({
  value,
  onChange,
  onSubmit,
  canSend,
  disabled,
  placeholder,
  testId = 'chat-message-input',
  rows,
  textareaRef,
  className,
  skillMenuClassName = 'left-0 w-[min(28rem,calc(100vw-2rem))]',
  onPasteFiles,
  onOpenSkillFile,
  workspaceTarget,
  workspaceFileApi,
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
}: ComposerTextareaProps) {
  const { t } = useTranslation('common')
  const menuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const skillsLoadedRef = useRef(false)
  const skillsLoadingRef = useRef(false)
  const skillsRequestIdRef = useRef(0)
  const skillsSourceRef = useRef<typeof onListLocalSkills>(undefined)
  const appsLoadedRef = useRef(false)
  const appsLoadingRef = useRef(false)
  const appsRequestIdRef = useRef(0)
  const appsSourceRef = useRef<typeof onListLocalApps>(undefined)
  const mountedRef = useRef(true)
  const editorRef = useRef<ComposerEditorHandle | null>(null)
  const valueRef = useRef(value)
  const activeMenuRef = useRef<ActiveComposerMenu | null>(null)
  const highlightedIndexRef = useRef(0)
  const showSkillMenuRef = useRef(false)
  const showSlashMenuRef = useRef(false)
  const activeOptionCountRef = useRef(0)
  const suppressEnterUntilKeyUpRef = useRef(false)
  const [skills, setSkills] = useState<LocalDeviceSkill[]>([])
  const [apps, setApps] = useState<LocalDeviceApp[]>([])
  const [isComposing, setIsComposing] = useState(false)
  const [activeMenu, setActiveMenu] = useState<ActiveComposerMenu | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [appsLoading, setAppsLoading] = useState(false)
  const [appsLoadError, setAppsLoadError] = useState(false)
  const canPickNativeWorkspacePaths =
    canOpenNativeWorkspacePathPicker() && workspaceTarget?.workspaceSource !== 'remote'

  useEffect(() => {
    valueRef.current = value
  }, [value])

  const { appCandidates, skillCandidates, mentionCandidates, filteredMentionCandidates } =
    useComposerMentionCandidates(
      apps,
      skills,
      selectedModel,
      activeMenu?.kind === 'skill' || activeMenu?.kind === 'mention' ? activeMenu.trigger.query : ''
    )

  const workspaceSearch = useWorkspaceMentionSearch(
    activeMenu?.kind === 'mention' ? activeMenu.trigger.query : '',
    workspaceTarget,
    workspaceFileApi
  )

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

  const actionSlashCommands = useMemo<SlashCommand[]>(() => {
    const commands: SlashCommand[] = []

    if (onSetPlanMode && !planModeActive) {
      commands.push({
        id: 'plan',
        title: t('workbench.slash_command_plan'),
        description: t('workbench.slash_command_plan_description'),
        searchAliases: ['plan', 'plan mode', 'planning'],
        Icon: ClipboardList,
        testId: 'plan',
        onSelect: onSetPlanMode,
      })
    }

    if (onSetGoal) {
      commands.push({
        id: 'goal',
        title: t('workbench.slash_command_goal'),
        description: t('workbench.slash_command_goal_description'),
        searchAliases: ['goal', 'target', 'objective'],
        Icon: Target,
        testId: 'goal',
        onSelect: onSetGoal,
      })
    }

    if (canOpenSlashModelMenu) {
      commands.push({
        id: 'model',
        title: t('workbench.slash_command_model'),
        description: t('workbench.slash_command_model_description'),
        searchAliases: ['model', 'model selector'],
        Icon: Cpu,
        testId: 'model',
        onSelect: openSlashModelMenu,
      })
    }

    return commands
  }, [canOpenSlashModelMenu, onSetGoal, onSetPlanMode, openSlashModelMenu, planModeActive, t])

  const skillSlashCommands = useMemo<SlashCommand[]>(() => {
    const skillGroup = t('workbench.slash_command_group_skills')
    return skillCandidates.map(candidate => ({
      id: candidate.key,
      title: candidate.title,
      description: candidate.description,
      metaLabel: candidate.metaLabel,
      group: skillGroup,
      searchAliases: candidate.searchAliases,
      Icon: Package,
      enabled: candidate.enabled,
      testId: slashSkillTestId(candidate.skill.name),
      skill: candidate.skill,
    }))
  }, [skillCandidates, t])

  const appSlashCommands = useMemo<SlashCommand[]>(() => {
    const appGroup = t('workbench.slash_command_group_apps', 'Apps')
    return appCandidates.map(candidate => ({
      id: candidate.key,
      title: candidate.title,
      description: candidate.description,
      metaLabel: candidate.metaLabel,
      group: appGroup,
      searchAliases: candidate.searchAliases,
      Icon: Plug,
      enabled: candidate.enabled,
      testId: slashAppTestId(candidate.app.id),
      app: candidate.app,
    }))
  }, [appCandidates, t])

  const slashCommands = useMemo(
    () => [...actionSlashCommands, ...skillSlashCommands, ...appSlashCommands],
    [actionSlashCommands, appSlashCommands, skillSlashCommands]
  )

  const filteredSlashCommands = useMemo(() => {
    if (activeMenu?.kind !== 'slash') return []
    return filterSlashCommands(
      slashCommands,
      activeMenu.trigger.query,
      hasDraftTextForSlashCommands(value)
    )
  }, [activeMenu, slashCommands, value])

  const showSkillMenu =
    (activeMenu?.kind === 'skill' || activeMenu?.kind === 'mention') &&
    (activeMenu.kind === 'mention' || Boolean(onListLocalSkills) || Boolean(onListLocalApps))
  const showSlashMenu = activeMenu?.kind === 'slash'
  const mentionMenuRows = useMemo<MentionMenuRow[]>(() => {
    if (!showSkillMenu) return []
    if (activeMenu?.kind === 'skill') {
      return filteredMentionCandidates.map(candidate => ({ kind: 'candidate', candidate }))
    }
    if (!activeMenu?.trigger.query.trim()) {
      return [
        { kind: 'files-action' },
        ...(onSetGoal ? ([{ kind: 'goal-action' }] as MentionMenuRow[]) : []),
        ...(!planModeActive && onSetPlanMode
          ? ([{ kind: 'plan-action' }] as MentionMenuRow[])
          : []),
        ...filteredMentionCandidates.map(
          candidate => ({ kind: 'candidate', candidate }) as MentionMenuRow
        ),
      ]
    }
    return [
      ...filteredMentionCandidates.map(
        candidate => ({ kind: 'candidate', candidate }) as MentionMenuRow
      ),
      ...workspaceSearch.matches.map(item => ({ kind: 'path', item }) as MentionMenuRow),
    ]
  }, [
    activeMenu,
    filteredMentionCandidates,
    onSetGoal,
    onSetPlanMode,
    planModeActive,
    showSkillMenu,
    workspaceSearch.matches,
  ])
  const activeOptionCount = showSkillMenu
    ? mentionMenuRows.length
    : showSlashMenu
      ? filteredSlashCommands.length
      : 0
  const highlightedIndex = Math.min(selectedIndex, Math.max(activeOptionCount - 1, 0))
  const hasMentionCandidates = mentionCandidates.length > 0
  const hasMentionLoadError = !hasMentionCandidates && (loadError || appsLoadError)
  const isMentionLoading = !hasMentionCandidates && (loading || appsLoading)
  const hasMentionSlashCommands = skillSlashCommands.length + appSlashCommands.length > 0
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

  const loadLocalSkills = useCallback(
    (options?: { force?: boolean }) => {
      if (!onListLocalSkills) return
      if (skillsSourceRef.current !== onListLocalSkills) {
        skillsSourceRef.current = onListLocalSkills
        skillsLoadedRef.current = false
        skillsLoadingRef.current = false
        skillsRequestIdRef.current += 1
        setSkills([])
      }
      if (skillsLoadedRef.current || skillsLoadingRef.current || (loadError && !options?.force)) {
        return
      }

      const requestId = skillsRequestIdRef.current + 1
      skillsRequestIdRef.current = requestId
      skillsLoadingRef.current = true
      setLoading(true)
      setLoadError(false)
      onListLocalSkills()
        .then(nextSkills => {
          if (!mountedRef.current || requestId !== skillsRequestIdRef.current) return
          skillsLoadedRef.current = true
          setLoadError(false)
          setSkills(nextSkills)
        })
        .catch(() => {
          if (!mountedRef.current || requestId !== skillsRequestIdRef.current) return
          skillsLoadedRef.current = false
          setLoadError(true)
        })
        .finally(() => {
          if (!mountedRef.current || requestId !== skillsRequestIdRef.current) return
          skillsLoadingRef.current = false
          setLoading(false)
        })
    },
    [loadError, onListLocalSkills]
  )

  const loadLocalApps = useCallback(
    (options?: { force?: boolean }) => {
      if (!onListLocalApps) return
      if (appsSourceRef.current !== onListLocalApps) {
        appsSourceRef.current = onListLocalApps
        appsLoadedRef.current = false
        appsLoadingRef.current = false
        appsRequestIdRef.current += 1
        setApps([])
      }
      if (appsLoadedRef.current || appsLoadingRef.current || (appsLoadError && !options?.force)) {
        return
      }

      const requestId = appsRequestIdRef.current + 1
      appsRequestIdRef.current = requestId
      appsLoadingRef.current = true
      setAppsLoading(true)
      setAppsLoadError(false)
      onListLocalApps()
        .then(nextApps => {
          if (!mountedRef.current || requestId !== appsRequestIdRef.current) return
          appsLoadedRef.current = true
          setAppsLoadError(false)
          setApps(nextApps)
        })
        .catch(() => {
          if (!mountedRef.current || requestId !== appsRequestIdRef.current) return
          appsLoadedRef.current = false
          setAppsLoadError(true)
        })
        .finally(() => {
          if (!mountedRef.current || requestId !== appsRequestIdRef.current) return
          appsLoadingRef.current = false
          setAppsLoading(false)
        })
    },
    [appsLoadError, onListLocalApps]
  )

  const loadLocalMentions = useCallback(
    (options?: { force?: boolean }) => {
      loadLocalSkills(options)
      loadLocalApps(options)
    },
    [loadLocalApps, loadLocalSkills]
  )

  const updateAutocompleteTrigger = useCallback(
    (snapshot?: ComposerEditorSnapshot) => {
      const editor = editorRef.current
      const current = snapshot ?? editor?.getSnapshot()
      if (!current) return

      const nextTrigger = chooseNearestTrigger([
        findStandaloneTrigger(current.value, current.selectionOffset, '@', 'mention'),
        onListLocalSkills
          ? findStandaloneTrigger(current.value, current.selectionOffset, '$', 'skill')
          : null,
        findStandaloneTrigger(current.value, current.selectionOffset, '/', 'slash'),
      ])
      const currentMenu = activeMenuRef.current
      const currentTriggerEnd = currentMenu
        ? currentMenu.trigger.start + 1 + currentMenu.trigger.query.length
        : null
      const nextTriggerEnd = nextTrigger ? nextTrigger.start + 1 + nextTrigger.query.length : null
      const triggerUnchanged =
        currentMenu &&
        nextTrigger &&
        currentMenu.kind === nextTrigger.kind &&
        currentMenu.trigger.start === nextTrigger.start &&
        currentTriggerEnd === nextTriggerEnd &&
        currentMenu.trigger.query === nextTrigger.query

      setActiveMenu(nextTrigger ? { kind: nextTrigger.kind, trigger: nextTrigger } : null)
      if (nextTrigger) {
        setModelMenuOpen(false)
        if (!triggerUnchanged) {
          setSelectedIndex(0)
          highlightedIndexRef.current = 0
        }
        if (
          nextTrigger.kind === 'skill' ||
          nextTrigger.kind === 'mention' ||
          onListLocalSkills ||
          onListLocalApps
        ) {
          loadLocalMentions()
        }
      }
    },
    [loadLocalMentions, onListLocalApps, onListLocalSkills]
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
      window.requestAnimationFrame(() =>
        updateAutocompleteTrigger({
          value: nextValue,
          selectionOffset: nextCursor,
          selectionStart: nextCursor,
          selectionEnd: nextCursor,
        })
      )
    },
    [onChange, updateAutocompleteTrigger]
  )

  const selectMentionCandidate = useCallback(
    (candidate: ComposerMentionCandidate, explicitTrigger?: ComposerTextTrigger | null) => {
      const trigger = explicitTrigger ?? activeMenuRef.current?.trigger
      const editor = editorRef.current
      if (!trigger || !editor) return false

      const snapshot = editor.getSnapshot()
      const replacement = replaceComposerMentionTrigger(
        snapshot.value,
        candidate.reference,
        trigger.start,
        snapshot.selectionEnd
      )

      commitEditorValue(replacement.value, replacement.cursor)
      closeAutocompleteMenu()
      textareaRef.current?.focus()
      editor.focus()
      return true
    },
    [closeAutocompleteMenu, commitEditorValue, textareaRef]
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
      command.onSelect?.()
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
      textareaRef,
    ]
  )

  const selectMentionMenuRow = useCallback(
    (row: MentionMenuRow, explicitTrigger?: ComposerTextTrigger) => {
      const trigger = explicitTrigger ?? activeMenuRef.current?.trigger
      const editor = editorRef.current
      if (!trigger || !editor) return false
      if (row.kind === 'candidate') {
        if (!row.candidate.enabled) return false
        return selectMentionCandidate(row.candidate)
      }

      const snapshot = editor.getSnapshot()
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
      if (row.kind === 'files-action') {
        void openNativeWorkspacePathPicker(workspaceTarget?.path)
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
            console.warn('[Wework composer] native workspace picker failed', error)
          })
      }
      editor.focus()
      return true
    },
    [
      closeAutocompleteMenu,
      commitEditorValue,
      onSetGoal,
      onSetPlanMode,
      selectMentionCandidate,
      workspaceTarget?.path,
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
  }, [filteredSlashCommands, selectSlashCommand, slashCommands])

  const getModelCompatibilityDisabledMessage = useCallback(
    (model: UnifiedModel): string | undefined => {
      if (!model.compatibilityDisabled) return undefined
      if (model.compatibilityDisabledReason === 'missing_current_runtime_family') {
        return t(
          'workbench.model_disabled_missing_current_runtime_family',
          'Current model is missing runtime.family'
        )
      }
      if (model.compatibilityDisabledReason === 'missing_target_runtime_family') {
        return t(
          'workbench.model_disabled_missing_target_runtime_family',
          'This model is missing runtime.family'
        )
      }
      if (model.compatibilityDisabledReason === 'unavailable') {
        return t('workbench.model_disabled_unavailable', 'This model is unavailable')
      }
      return t(
        'workbench.model_disabled_runtime_family_mismatch',
        'Incompatible with the current model protocol'
      )
    },
    [t]
  )

  const selectSlashModel = useCallback(
    (model: UnifiedModel) => {
      onSelectModel?.(model)
      closeSlashModelMenu(true)
    },
    [closeSlashModelMenu, onSelectModel]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const handleFocusRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ expectedValue?: string }>).detail
      if (detail?.expectedValue && detail.expectedValue !== valueRef.current) return
      const editor = editorRef.current
      if (!editor) return
      editor.setValue(valueRef.current, valueRef.current.length)
      editor.focus()
      closeAutocompleteMenu()
    }

    window.addEventListener(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, handleFocusRequest)
    return () => {
      window.removeEventListener(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, handleFocusRequest)
    }
  }, [closeAutocompleteMenu])

  useEffect(() => {
    if (!showSkillMenu && !showSlashMenu) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        target instanceof Node &&
        (menuRef.current?.contains(target) || textareaRef.current?.contains(target))
      ) {
        return
      }
      closeAutocompleteMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [closeAutocompleteMenu, showSkillMenu, showSlashMenu, textareaRef])

  useEffect(() => {
    if (!modelMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        target instanceof Node &&
        (modelMenuRef.current?.contains(target) || textareaRef.current?.contains(target))
      ) {
        return
      }
      closeSlashModelMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [closeSlashModelMenu, modelMenuOpen, textareaRef])

  const handleCompositionStart = useCallback(() => {
    setIsComposing(true)
    debugComposerEvent('composition-start', {
      propValue: textMetrics(valueRef.current),
      suppressEnterUntilKeyUp: suppressEnterUntilKeyUpRef.current,
    })
  }, [])

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false)
    suppressEnterUntilKeyUpRef.current = true
    debugComposerEvent('composition-end', {
      propValue: textMetrics(valueRef.current),
      suppressEnterUntilKeyUp: suppressEnterUntilKeyUpRef.current,
    })
  }, [])

  const handleKeyUp = (event: KeyboardEvent) => {
    if (suppressEnterUntilKeyUpRef.current) {
      suppressEnterUntilKeyUpRef.current = false
      debugComposerEvent('keyup-clear-composition-enter-suppression', {
        key: event.key,
        propValue: textMetrics(valueRef.current),
      })
    }
    updateAutocompleteTrigger()
  }

  const handleEditorSnapshot = useCallback(
    (snapshot: ComposerEditorSnapshot) => {
      valueRef.current = snapshot.value
      updateAutocompleteTrigger(snapshot)
    },
    [updateAutocompleteTrigger]
  )

  const handleEditorBeforeInput = useCallback((event: InputEvent) => {
    if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') {
      return false
    }
    return suppressEnterUntilKeyUpRef.current
  }, [])

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent, snapshot: ComposerEditorSnapshot) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!showSkillMenuRef.current && !showSlashMenuRef.current) return false
        if (activeOptionCountRef.current <= 0) return false
        event.preventDefault()
        return moveHighlightedIndex(event.key === 'ArrowDown' ? 1 : -1)
      }

      if (event.key === 'Escape') {
        if (!showSkillMenuRef.current && !showSlashMenuRef.current) return false
        event.preventDefault()
        closeAutocompleteMenu()
        return true
      }

      if (event.key === 'Enter') {
        debugComposerEvent('keydown-enter', {
          shiftKey: event.shiftKey,
          canSend,
          stateIsComposing: isComposing,
          nativeIsComposing: event.isComposing,
          suppressEnterUntilKeyUp: suppressEnterUntilKeyUpRef.current,
          showSkillMenu: showSkillMenuRef.current,
          showSlashMenu: showSlashMenuRef.current,
          highlightedIndex: highlightedIndexRef.current,
          activeOptionCount: activeOptionCountRef.current,
          domValue: textMetrics(snapshot.value),
        })

        if (isComposing || isImeEnterEvent(event) || isImeComposingEvent(event)) {
          suppressEnterUntilKeyUpRef.current = true
          return false
        }
        if (suppressEnterUntilKeyUpRef.current) {
          event.preventDefault()
          return true
        }
        if (showSkillMenuRef.current && selectHighlightedMention()) {
          suppressEnterUntilKeyUpRef.current = true
          event.preventDefault()
          event.stopPropagation()
          return true
        }
        if (showSlashMenuRef.current && selectHighlightedSlashCommand()) {
          suppressEnterUntilKeyUpRef.current = true
          event.preventDefault()
          event.stopPropagation()
          return true
        }
        if (event.shiftKey && !event.metaKey && !event.ctrlKey) return false

        event.preventDefault()
        if (snapshot.value.trim().length > 0 || canSend) {
          const modifierPressed = event.metaKey || event.ctrlKey
          onSubmit(
            snapshot.value,
            modifierPressed
              ? event.shiftKey
                ? { interruptWhenBusy: true }
                : { guideWhenBusy: true }
              : undefined
          )
        }
        return true
      }

      if (event.key !== 'Backspace' && event.key !== 'Delete') return false
      const range = findComposerMentionDeletionRange(
        snapshot.value,
        snapshot.selectionStart,
        snapshot.selectionEnd,
        event.key
      )
      if (!range) return false
      event.preventDefault()
      const nextValue = snapshot.value.slice(0, range.start) + snapshot.value.slice(range.end)
      editorRef.current?.setValue(nextValue, range.cursor)
      return true
    },
    [
      canSend,
      closeAutocompleteMenu,
      isComposing,
      moveHighlightedIndex,
      onSubmit,
      selectHighlightedMention,
      selectHighlightedSlashCommand,
    ]
  )

  const handlePaste = useCallback(
    (event: ClipboardEvent) => {
      if (!onPasteFiles || !event.clipboardData) return false
      const files = Array.from(event.clipboardData.files)
      if (files.length > 0) {
        event.preventDefault()
        onPasteFiles(files)
        return true
      }
      const textAttachment = createLongPastedTextAttachment(
        event.clipboardData.getData('text/plain')
      )
      if (!textAttachment) return false
      event.preventDefault()
      onPasteFiles([textAttachment])
      return true
    },
    [onPasteFiles]
  )

  const handleDrop = useCallback(
    (event: DragEvent) => {
      if (!onPasteFiles) return false
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) return false
      event.preventDefault()
      event.stopPropagation()
      onPasteFiles(files)
      return true
    },
    [onPasteFiles]
  )

  return (
    <div className="relative min-w-0 flex-1 w-full">
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
        onPaste={handlePaste}
        onDrop={handleDrop}
        onOpenMentionFile={onOpenSkillFile}
        onClick={() => updateAutocompleteTrigger()}
        onFocus={() => updateAutocompleteTrigger()}
        disabled={disabled}
        placeholder={placeholder}
        testId={testId}
        rows={rows}
        textareaRef={textareaRef}
        className={className}
      />
      {showSkillMenu && (
        <ComposerMentionMenu
          menuRef={menuRef}
          rows={mentionMenuRows}
          selectedIndex={highlightedIndex}
          className={skillMenuClassName}
          mentionMode={activeMenu?.kind === 'mention'}
          loading={isMentionLoading || workspaceSearch.loading}
          error={hasMentionLoadError || workspaceSearch.error}
          canBrowseFiles={canPickNativeWorkspacePaths}
          onRetry={() => loadLocalMentions({ force: true })}
          onHighlight={setSelectedIndex}
          onSelect={handleMentionRowClick}
        />
      )}
      {showSlashMenu && (
        <div ref={menuRef}>
          <SlashCommandMenu
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
            onSelectCommand={command => selectSlashCommand(command)}
            onHighlightCommand={setSelectedIndex}
            onRetrySkills={() => loadLocalMentions({ force: true })}
          />
        </div>
      )}
      {modelMenuOpen && (
        <div ref={modelMenuRef}>
          <SlashModelMenu
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
    </div>
  )
}
