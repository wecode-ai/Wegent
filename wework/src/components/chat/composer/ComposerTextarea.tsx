import { ClipboardList, Cpu, Package, Plug, Target } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEventHandler, RefObject } from 'react'
import type { InitialConfigType } from '@lexical/react/LexicalComposer'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import {
  $addUpdateTag,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  $getSelection,
  $isRangeSelection,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  DROP_COMMAND,
  PASTE_COMMAND,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  type LexicalEditor,
} from 'lexical'
import { useTranslation } from '@/hooks/useTranslation'
import { FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT } from '@/features/plugins/pluginTrial'
import { isImeComposingEvent, isImeEnterEvent } from '@/lib/ime'
import { getModelCompatibilityFamily, inferModelFamily } from '@/lib/model-ui'
import type { LocalDeviceApp, LocalDeviceSkill, ModelOptions, UnifiedModel } from '@/types/api'
import { ComposerSkillNode, displaySkillNameFromName, localSkillTestId } from './ComposerSkillNode'
import type { ComposerTextTrigger, SlashCommand } from './composerAutocomplete'
import {
  chooseNearestTrigger,
  filterSlashCommands,
  findStandaloneTrigger,
  hasDraftTextForSlashCommands,
} from './composerAutocomplete'
import {
  $getComposerSelectionRange,
  $getComposerValue,
  $selectComposerOffset,
  $setComposerValue,
  parseComposerSkillReferences,
} from './composerLexicalSerialization'
import { createLongPastedTextAttachment } from './pastedTextAttachment'
import { SlashCommandMenu } from './SlashCommandMenu'
import { SlashModelMenu } from './SlashModelMenu'
import { debugComposerEvent, textMetrics } from './composerDebug'

export interface ComposerSubmitOptions {
  guideWhenBusy?: boolean
}

interface ComposerTextareaProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (submittedValue?: string, options?: ComposerSubmitOptions) => void
  canSend: boolean
  disabled?: boolean
  placeholder: string
  testId?: string
  rows: number
  textareaRef: RefObject<HTMLElement | null>
  className: string
  skillMenuClassName?: string
  onPasteFiles?: (files: File[]) => void
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
}

interface ActiveComposerMenu {
  kind: ComposerTextTrigger['kind']
  trigger: ComposerTextTrigger
}

interface ComposerEditorSnapshot {
  value: string
  selectionOffset: number
  selectionStart: number
  selectionEnd: number
}

interface FocusPluginTrialComposerEventDetail {
  expectedValue?: string
}

type CommonTranslate = ReturnType<typeof useTranslation>['t']
const COMPOSER_SKILL_REFERENCE_ATTRIBUTE = 'data-composer-skill-reference'

function displaySkillName(skill: LocalDeviceSkill): string {
  return displaySkillNameFromName(skill.name)
}

function displayAppName(app: LocalDeviceApp): string {
  return app.name || app.id
}

function displaySkillSource(skill: LocalDeviceSkill, t: CommonTranslate): string {
  if (skill.source_label) return skill.source_label

  switch (skill.scope) {
    case 'user':
    case 'repo':
      return t('workbench.skill_scope_personal', 'Personal')
    case 'system':
    case 'admin':
      return t('workbench.skill_scope_system', 'System')
    default:
      break
  }

  if (skill.source === 'codex') return t('workbench.skill_scope_personal', 'Personal')
  if (skill.source === 'codex-plugin') return t('workbench.skill_scope_personal', 'Personal')
  return skill.source
}

function isClaudeSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents' || skill.source === 'claude' || skill.source === 'claude-plugin'
}

function isCodexSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents' || skill.source === 'codex' || skill.source === 'codex-plugin'
}

function isSharedSkill(skill: LocalDeviceSkill): boolean {
  return skill.source === 'agents'
}

function normalizeRuntimeSignal(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getModelConfigProvider(model: UnifiedModel): string {
  const config = getObjectRecord(model.config)
  const directEnv = getObjectRecord(config?.env)
  const nestedModelConfig = getObjectRecord(config?.modelConfig)
  const nestedEnv = getObjectRecord(nestedModelConfig?.env)
  return (
    normalizeRuntimeSignal(model.runtime?.provider) ||
    normalizeRuntimeSignal(directEnv?.model) ||
    normalizeRuntimeSignal(nestedEnv?.model) ||
    normalizeRuntimeSignal(model.provider)
  )
}

function runtimeProtocolFromFamily(runtimeFamily: string | null): string {
  if (!runtimeFamily) return ''
  const parts = runtimeFamily.split('.').filter(Boolean)
  return parts.at(-1) ?? runtimeFamily
}

function inferSkillRuntime(model: UnifiedModel): 'claude' | 'codex' | null {
  const provider = getModelConfigProvider(model)
  const runtimeFamily = getModelCompatibilityFamily(model)
  const runtimeProtocol = runtimeProtocolFromFamily(runtimeFamily)
  const protocol = normalizeRuntimeSignal(model.config?.protocol)
  const apiFormat = normalizeRuntimeSignal(model.config?.apiFormat ?? model.config?.api_format)

  if (provider === 'claude') return 'claude'
  if (provider === 'openai') return 'codex'
  if (runtimeProtocol === 'claude') return 'claude'
  if (runtimeProtocol === 'openai-responses') return 'codex'
  if (protocol === 'claude') return 'claude'
  if (protocol === 'openai-responses' || apiFormat === 'responses') return 'codex'

  const family = inferModelFamily(model)
  if (family === 'claude') return 'claude'
  if (family === 'gpt') return 'codex'
  return null
}

function canSelectSkillForModel(
  skill: LocalDeviceSkill,
  selectedModel?: UnifiedModel | null
): boolean {
  if (!selectedModel) return true

  const runtime = inferSkillRuntime(selectedModel)
  if (runtime === 'claude') return isClaudeSkill(skill)
  if (runtime === 'codex') return isCodexSkill(skill)

  return isSharedSkill(skill) || !isCodexSkill(skill)
}

function slashSkillTestId(name: string): string {
  return `skill-${localSkillTestId(name)}`
}

function slashAppTestId(id: string): string {
  return `app-${localSkillTestId(id)}`
}

function skillIdentityKey(skill: LocalDeviceSkill): string {
  return (skill.name || skill.path).trim().toLowerCase()
}

function skillSourceRank(skill: LocalDeviceSkill): number {
  if (skill.source_priority !== undefined) return skill.source_priority
  if (skill.source === 'codex') return 0
  if (skill.source === 'codex-plugin') return 1
  return 2
}

function preferLocalSkill(left: LocalDeviceSkill, right: LocalDeviceSkill): LocalDeviceSkill {
  const leftRank = skillSourceRank(left)
  const rightRank = skillSourceRank(right)
  if (leftRank !== rightRank) return leftRank < rightRank ? left : right
  return (left.mtime ?? 0) >= (right.mtime ?? 0) ? left : right
}

function dedupeLocalSkills(input: LocalDeviceSkill[]): LocalDeviceSkill[] {
  const deduped = new Map<string, LocalDeviceSkill>()
  input.forEach(skill => {
    const key = skillIdentityKey(skill)
    const current = deduped.get(key)
    deduped.set(key, current ? preferLocalSkill(current, skill) : skill)
  })
  return Array.from(deduped.values())
}

function skillReference(skill: LocalDeviceSkill): string {
  return `[$${skill.name}](skill://${skill.path})`
}

function appReference(app: LocalDeviceApp): string {
  return `[$${app.name || app.id}](app://${app.id})`
}

type ComposerMentionCandidate =
  | {
      kind: 'skill'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      skill: LocalDeviceSkill
    }
  | {
      kind: 'app'
      key: string
      title: string
      description?: string
      metaLabel: string
      testId: string
      enabled: boolean
      reference: string
      searchAliases: string[]
      app: LocalDeviceApp
    }

type ComposerSkillMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'skill' }>
type ComposerAppMentionCandidate = Extract<ComposerMentionCandidate, { kind: 'app' }>

function readComposerEditorSnapshot(editor: LexicalEditor): ComposerEditorSnapshot {
  let snapshot: ComposerEditorSnapshot = {
    value: '',
    selectionOffset: 0,
    selectionStart: 0,
    selectionEnd: 0,
  }
  editor.getEditorState().read(() => {
    const value = $getComposerValue()
    const selectionRange = $getComposerSelectionRange()
    snapshot = {
      value,
      selectionOffset: selectionRange.end,
      selectionStart: selectionRange.start,
      selectionEnd: selectionRange.end,
    }
  })
  return snapshot
}

function composerDomNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length
  if (!(node instanceof HTMLElement)) return 0
  const reference = node.getAttribute(COMPOSER_SKILL_REFERENCE_ATTRIBUTE)
  if (reference) return reference.length
  if (node.tagName === 'BR') return 1
  return Array.from(node.childNodes).reduce((sum, child) => sum + composerDomNodeLength(child), 0)
}

function serializeComposerDomNode(node: Node, parts: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parts.push(node.textContent ?? '')
    return
  }
  if (!(node instanceof HTMLElement)) return

  const reference = node.getAttribute(COMPOSER_SKILL_REFERENCE_ATTRIBUTE)
  if (reference) {
    parts.push(reference)
    return
  }
  if (node.tagName === 'BR') {
    parts.push('\n')
    return
  }

  node.childNodes.forEach(child => serializeComposerDomNode(child, parts))
}

function serializeComposerDom(rootElement: HTMLElement): string {
  const parts: string[] = []
  Array.from(rootElement.childNodes).forEach((node, index) => {
    if (index > 0) parts.push('\n')
    serializeComposerDomNode(node, parts)
  })
  return parts.join('')
}

function getComposerDomSelectionOffset(rootElement: HTMLElement): number {
  const selection = rootElement.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) return serializeComposerDom(rootElement).length
  const range = selection.getRangeAt(0)
  if (!rootElement.contains(range.startContainer)) return serializeComposerDom(rootElement).length

  let offset = 0
  let found = false

  const visit = (node: Node) => {
    if (found) return
    if (node === range.startContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += Math.min(range.startOffset, (node.textContent ?? '').length)
      } else {
        Array.from(node.childNodes)
          .slice(0, range.startOffset)
          .forEach(child => {
            offset += composerDomNodeLength(child)
          })
      }
      found = true
      return
    }

    if (node instanceof HTMLElement && node.contains(range.startContainer)) {
      Array.from(node.childNodes).forEach(visit)
      return
    }

    offset += composerDomNodeLength(node)
  }

  Array.from(rootElement.childNodes).forEach((node, index) => {
    if (found) return
    if (index > 0) offset += 1
    visit(node)
  })
  return offset
}

function findMentionDeletionRange(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  key: 'Backspace' | 'Delete'
): { start: number; end: number; cursor: number } | null {
  const references = parseComposerSkillReferences(value)
  if (selectionStart !== selectionEnd) {
    let start = selectionStart
    let end = selectionEnd
    let intersects = false
    references.forEach(reference => {
      if (reference.end <= start || reference.start >= end) return
      intersects = true
      start = Math.min(start, reference.start)
      end = Math.max(end, reference.end)
    })
    return intersects ? { start, end, cursor: start } : null
  }

  const cursor = selectionStart
  const reference = references.find(item =>
    key === 'Backspace'
      ? cursor > item.start && cursor <= item.end + 1
      : cursor >= item.start && cursor < item.end
  )
  if (!reference) return null

  const end =
    key === 'Backspace' && value[reference.end] === ' ' ? reference.end + 1 : reference.end
  return { start: reference.start, end, cursor: reference.start }
}

function ComposerValuePlugin({
  value,
  onChange,
  onEditorReady,
  onTriggerChange,
  isComposing,
}: {
  value: string
  onChange: (value: string) => void
  onEditorReady: (editor: LexicalEditor) => void
  onTriggerChange: (snapshot: ComposerEditorSnapshot) => void
  isComposing: boolean
}) {
  const [editor] = useLexicalComposerContext()
  const lastEditorValueRef = useRef(value)

  useEffect(() => {
    onEditorReady(editor)
  }, [editor, onEditorReady])

  useEffect(() => {
    if (isComposing) return
    if (value === lastEditorValueRef.current) return
    const editorFocused = editor.getRootElement() === document.activeElement

    editor.update(
      () => {
        const currentValue = $getComposerValue()
        if (currentValue === value) {
          lastEditorValueRef.current = value
          return
        }
        $setComposerValue(value, editorFocused ? value.length : undefined)
        lastEditorValueRef.current = value
      },
      editorFocused ? undefined : { tag: SKIP_DOM_SELECTION_TAG }
    )
  }, [editor, isComposing, value])

  return (
    <OnChangePlugin
      ignoreSelectionChange={false}
      onChange={editorState => {
        editorState.read(() => {
          const nextValue = $getComposerValue()
          const selectionRange = $getComposerSelectionRange()
          const snapshot = {
            value: nextValue,
            selectionOffset: selectionRange.end,
            selectionStart: selectionRange.start,
            selectionEnd: selectionRange.end,
          }
          onTriggerChange(snapshot)
          if (nextValue !== lastEditorValueRef.current) {
            lastEditorValueRef.current = nextValue
            onChange(nextValue)
          }
        })
      }}
    />
  )
}

function ComposerCommandPlugin({
  canSend,
  closeAutocompleteMenu,
  getActiveOptionCount,
  getHighlightedIndex,
  getShowSkillMenu,
  getShowSlashMenu,
  getSuppressEnter,
  isComposing,
  onPasteFiles,
  onMoveHighlightedIndex,
  onSelectHighlightedMention,
  onSelectHighlightedSlashCommand,
  onSubmit,
  setSuppressEnter,
  syncAutocomplete,
}: {
  canSend: boolean
  closeAutocompleteMenu: () => void
  getActiveOptionCount: () => number
  getHighlightedIndex: () => number
  getShowSkillMenu: () => boolean
  getShowSlashMenu: () => boolean
  getSuppressEnter: () => boolean
  isComposing: boolean
  onPasteFiles?: (files: File[]) => void
  onMoveHighlightedIndex: (delta: number) => boolean
  onSelectHighlightedMention: () => boolean
  onSelectHighlightedSlashCommand: () => boolean
  onSubmit: (submittedValue?: string, options?: ComposerSubmitOptions) => void
  setSuppressEnter: (value: boolean) => void
  syncAutocomplete: () => void
}) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    const cleanups = [
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          syncAutocomplete()
          return false
        },
        COMMAND_PRIORITY_LOW
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_ARROW_DOWN_COMMAND,
        event => {
          if (!getShowSkillMenu() && !getShowSlashMenu()) return false
          if (getActiveOptionCount() <= 0) return false
          event.preventDefault()
          return onMoveHighlightedIndex(1)
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_ARROW_UP_COMMAND,
        event => {
          if (!getShowSkillMenu() && !getShowSlashMenu()) return false
          if (getActiveOptionCount() <= 0) return false
          event.preventDefault()
          return onMoveHighlightedIndex(-1)
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_ESCAPE_COMMAND,
        event => {
          if (!getShowSkillMenu() && !getShowSlashMenu()) return false
          event.preventDefault()
          closeAutocompleteMenu()
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_ENTER_COMMAND,
        event => {
          const snapshot = readComposerEditorSnapshot(editor)
          debugComposerEvent('keydown-enter', {
            shiftKey: event.shiftKey,
            canSend,
            stateIsComposing: isComposing,
            nativeIsComposing: event.isComposing,
            suppressEnterUntilKeyUp: getSuppressEnter(),
            showSkillMenu: getShowSkillMenu(),
            showSlashMenu: getShowSlashMenu(),
            highlightedIndex: getHighlightedIndex(),
            activeOptionCount: getActiveOptionCount(),
            domValue: textMetrics(snapshot.value),
          })

          if (isComposing || isImeEnterEvent(event) || isImeComposingEvent(event)) {
            setSuppressEnter(true)
            return false
          }

          if (getSuppressEnter()) {
            event.preventDefault()
            return true
          }

          if (getShowSkillMenu() && onSelectHighlightedMention()) {
            event.preventDefault()
            return true
          }
          if (getShowSlashMenu() && onSelectHighlightedSlashCommand()) {
            event.preventDefault()
            return true
          }

          if (event.shiftKey) return false

          event.preventDefault()
          const submittedValue = snapshot.value
          const canSubmitCurrentValue = submittedValue.trim().length > 0 || canSend
          if (canSubmitCurrentValue) {
            if (event.metaKey || event.ctrlKey) {
              onSubmit(submittedValue, { guideWhenBusy: true })
            } else {
              onSubmit(submittedValue)
            }
          }
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_BACKSPACE_COMMAND,
        event => {
          const snapshot = readComposerEditorSnapshot(editor)
          const range = findMentionDeletionRange(
            snapshot.value,
            snapshot.selectionStart,
            snapshot.selectionEnd,
            'Backspace'
          )
          if (!range) return false
          event.preventDefault()
          editor.update(() => {
            const nextValue = snapshot.value.slice(0, range.start) + snapshot.value.slice(range.end)
            $setComposerValue(nextValue, range.cursor)
          })
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand<KeyboardEvent>(
        KEY_DELETE_COMMAND,
        event => {
          const snapshot = readComposerEditorSnapshot(editor)
          const range = findMentionDeletionRange(
            snapshot.value,
            snapshot.selectionStart,
            snapshot.selectionEnd,
            'Delete'
          )
          if (!range) return false
          event.preventDefault()
          editor.update(() => {
            const nextValue = snapshot.value.slice(0, range.start) + snapshot.value.slice(range.end)
            $setComposerValue(nextValue, range.cursor)
          })
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand<ClipboardEvent>(
        PASTE_COMMAND,
        event => {
          if (!onPasteFiles) return false
          const clipboardData = event.clipboardData
          if (!clipboardData) return false

          const files = Array.from(clipboardData.files)
          if (files.length > 0) {
            event.preventDefault()
            onPasteFiles(files)
            return true
          }

          const textAttachment = createLongPastedTextAttachment(clipboardData.getData('text/plain'))
          if (!textAttachment) return false

          event.preventDefault()
          onPasteFiles([textAttachment])
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand<DragEvent>(
        DROP_COMMAND,
        event => {
          if (!onPasteFiles) return false
          const files = Array.from(event.dataTransfer?.files ?? [])
          if (files.length === 0) return false

          event.preventDefault()
          event.stopPropagation()
          onPasteFiles(files)
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
    ]

    return () => cleanups.forEach(cleanup => cleanup())
  }, [
    canSend,
    closeAutocompleteMenu,
    editor,
    getActiveOptionCount,
    getHighlightedIndex,
    getShowSkillMenu,
    getShowSlashMenu,
    getSuppressEnter,
    isComposing,
    onMoveHighlightedIndex,
    onPasteFiles,
    onSelectHighlightedMention,
    onSelectHighlightedSlashCommand,
    onSubmit,
    setSuppressEnter,
    syncAutocomplete,
  ])

  return null
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
  const editorRef = useRef<LexicalEditor | null>(null)
  const composerElementRef = useRef<HTMLDivElement | null>(null)
  const textareaRefRef = useRef(textareaRef)
  const commitEditorValueRef = useRef<(value: string, cursor: number) => void>(() => {})
  const valueRef = useRef(value)
  const selectionRangeRef = useRef({ start: value.length, end: value.length })
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

  useEffect(() => {
    valueRef.current = value
  }, [value])
  useLayoutEffect(() => {
    textareaRefRef.current = textareaRef
    ;(textareaRef as { current: HTMLElement | null }).current = composerElementRef.current
  }, [textareaRef])

  const dedupedSkills = useMemo(() => dedupeLocalSkills(skills), [skills])

  const appCandidates = useMemo<ComposerAppMentionCandidate[]>(
    () =>
      apps.map(app => {
        const pluginNames = app.pluginDisplayNames ?? []
        return {
          kind: 'app',
          key: `app:${app.id}`,
          title: displayAppName(app),
          description: app.description ?? undefined,
          metaLabel: pluginNames[0] ?? t('workbench.skill_scope_personal', 'Personal'),
          testId: localSkillTestId(app.id),
          enabled: app.isEnabled !== false && app.isAccessible !== false,
          reference: appReference(app),
          searchAliases: [app.id, app.name, app.description ?? '', ...pluginNames],
          app,
        }
      }),
    [apps, t]
  )

  const skillCandidates = useMemo<ComposerSkillMentionCandidate[]>(() => {
    return dedupedSkills.map(skill => {
      const description = skill.short_description || skill.description || undefined
      return {
        kind: 'skill',
        key: `skill:${skill.path}`,
        title: displaySkillName(skill),
        description,
        metaLabel: displaySkillSource(skill, t),
        testId: localSkillTestId(skill.name),
        enabled: canSelectSkillForModel(skill, selectedModel),
        reference: skillReference(skill),
        searchAliases: [skill.name, skill.plugin_name ?? '', description ?? ''],
        skill,
      }
    })
  }, [dedupedSkills, selectedModel, t])

  const mentionCandidates = useMemo(
    () => [...skillCandidates, ...appCandidates],
    [appCandidates, skillCandidates]
  )

  const filteredMentionCandidates = useMemo(() => {
    const query = activeMenu?.kind === 'skill' ? activeMenu.trigger.query.trim().toLowerCase() : ''
    if (!query) return mentionCandidates

    return mentionCandidates.filter(candidate => {
      const description = candidate.description || ''
      return (
        candidate.title.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query) ||
        candidate.searchAliases.some(alias => alias.toLowerCase().includes(query))
      )
    })
  }, [activeMenu, mentionCandidates])

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
    activeMenu?.kind === 'skill' && (Boolean(onListLocalSkills) || Boolean(onListLocalApps))
  const showSlashMenu = activeMenu?.kind === 'slash'
  const activeOptionCount = showSkillMenu
    ? filteredMentionCandidates.length
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

  useEffect(() => {
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
      const current = snapshot ?? (editor ? readComposerEditorSnapshot(editor) : null)
      if (!current) return
      selectionRangeRef.current = {
        start: current.selectionStart,
        end: current.selectionEnd,
      }

      const nextTrigger = chooseNearestTrigger([
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
        if (nextTrigger.kind === 'skill' || onListLocalSkills || onListLocalApps) {
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
      selectionRangeRef.current = { start: nextCursor, end: nextCursor }
      onChange(nextValue)
      if (!editor) return
      editor.update(() => {
        $setComposerValue(nextValue, nextCursor)
      })
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
  useLayoutEffect(() => {
    commitEditorValueRef.current = commitEditorValue
  }, [commitEditorValue])

  const selectMentionCandidate = useCallback(
    (candidate: ComposerMentionCandidate, explicitTrigger?: ComposerTextTrigger | null) => {
      const trigger = explicitTrigger ?? activeMenuRef.current?.trigger
      const editor = editorRef.current
      if (!trigger || !editor) return false

      const snapshot = readComposerEditorSnapshot(editor)
      const replacement = `${candidate.reference} `
      const nextValue =
        snapshot.value.slice(0, trigger.start) +
        replacement +
        snapshot.value.slice(snapshot.selectionEnd)
      const nextCursor = trigger.start + replacement.length

      commitEditorValue(nextValue, nextCursor)
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

      const snapshot = readComposerEditorSnapshot(editor)
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

  const selectHighlightedMention = useCallback(() => {
    const candidate = filteredMentionCandidates[highlightedIndexRef.current]
    if (!candidate || !candidate.enabled) return false
    return selectMentionCandidate(candidate)
  }, [filteredMentionCandidates, selectMentionCandidate])

  const selectHighlightedSlashCommand = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return false
    const snapshot = readComposerEditorSnapshot(editor)
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

  const handleEditorReady = useCallback(
    (editor: LexicalEditor) => {
      editorRef.current = editor
      editor.setEditable(!disabled)
    },
    [disabled]
  )

  const setComposerElementRef = useCallback((element: HTMLDivElement | null) => {
    composerElementRef.current = element
    ;(textareaRefRef.current as { current: HTMLElement | null }).current = element
    if (!element) return
    Object.defineProperty(element, 'value', {
      configurable: true,
      get: () => valueRef.current,
      set: nextValue => {
        const normalizedValue = String(nextValue ?? '')
        commitEditorValueRef.current(normalizedValue, normalizedValue.length)
      },
    })
  }, [])

  useEffect(() => {
    const element = composerElementRef.current
    if (!element) return
    element.setAttribute('placeholder', placeholder)
    element.setAttribute('rows', String(rows))
  }, [placeholder, rows])

  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: 'WeworkComposer',
      nodes: [ComposerSkillNode],
      theme: {
        paragraph: 'm-0',
      },
      editorState: () => {
        $addUpdateTag(SKIP_DOM_SELECTION_TAG)
        $setComposerValue(value)
      },
      onError(error) {
        throw error
      },
    }),
    [value]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    editorRef.current?.setEditable(!disabled)
  }, [disabled])

  useEffect(() => {
    const handleFocusRequest = (event: Event) => {
      const detail = (event as CustomEvent<FocusPluginTrialComposerEventDetail>).detail
      if (detail?.expectedValue && detail.expectedValue !== valueRef.current) return
      const editor = editorRef.current
      if (!editor) return
      editor.focus(() => {
        editor.update(() => {
          $selectComposerOffset($getComposerValue().length)
        })
      })
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

  const handleKeyUp: KeyboardEventHandler<HTMLDivElement> = event => {
    if (suppressEnterUntilKeyUpRef.current) {
      suppressEnterUntilKeyUpRef.current = false
      debugComposerEvent('keyup-clear-composition-enter-suppression', {
        key: event.key,
        propValue: textMetrics(valueRef.current),
      })
    }
    updateAutocompleteTrigger()
  }

  const ensureEditorSelection = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const rootElement = editor.getRootElement()
    const domSelection = window.getSelection()
    const domSelectionWithinEditor = Boolean(
      rootElement && domSelection?.anchorNode && rootElement.contains(domSelection.anchorNode)
    )
    editor.update(() => {
      const latestValue = valueRef.current
      const cursor = Math.min(selectionRangeRef.current.end, latestValue.length)
      if ($getComposerValue() !== latestValue) {
        $setComposerValue(latestValue, cursor)
        return
      }
      const selection = $getSelection()
      if (!domSelectionWithinEditor || !$isRangeSelection(selection)) {
        $selectComposerOffset(cursor)
      }
    })
  }, [])

  const syncDomInputToEditor = useCallback(
    (element: HTMLElement) => {
      if (isComposing) return
      const editor = editorRef.current
      if (!editor) return

      const domValue = serializeComposerDom(element)
      const snapshot = readComposerEditorSnapshot(editor)
      if (domValue === snapshot.value) return

      const cursor = getComposerDomSelectionOffset(element)
      valueRef.current = domValue
      selectionRangeRef.current = { start: cursor, end: cursor }
      editor.update(() => {
        $setComposerValue(domValue, cursor)
      })
    },
    [isComposing]
  )

  return (
    <div className="relative min-w-0 flex-1 w-full">
      <LexicalComposer initialConfig={initialConfig}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              ref={setComposerElementRef}
              data-testid={testId}
              placeholder={null}
              role="textbox"
              aria-multiline="true"
              spellCheck
              className={`${className} relative z-30 whitespace-pre-wrap break-words`}
              onBeforeInputCapture={() => {
                ensureEditorSelection()
              }}
              onInput={event => syncDomInputToEditor(event.currentTarget)}
              onKeyUp={handleKeyUp}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={event => {
                handleCompositionEnd()
                syncDomInputToEditor(event.currentTarget)
              }}
              onDropCapture={event => {
                const files = Array.from(event.dataTransfer.files)
                if (files.length === 0) return
                event.preventDefault()
                event.stopPropagation()
                onPasteFiles?.(files)
              }}
              onClick={() => updateAutocompleteTrigger()}
              onFocus={() => {
                ensureEditorSelection()
                updateAutocompleteTrigger()
              }}
            />
          }
          placeholder={
            <div
              className={`${className} pointer-events-none absolute inset-0 !text-text-muted/55`}
            >
              {placeholder}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <ComposerValuePlugin
          value={value}
          onChange={onChange}
          onEditorReady={handleEditorReady}
          onTriggerChange={updateAutocompleteTrigger}
          isComposing={isComposing}
        />
        <ComposerCommandPlugin
          canSend={canSend}
          closeAutocompleteMenu={closeAutocompleteMenu}
          getActiveOptionCount={() => activeOptionCountRef.current}
          getHighlightedIndex={() => highlightedIndexRef.current}
          getShowSkillMenu={() => showSkillMenuRef.current}
          getShowSlashMenu={() => showSlashMenuRef.current}
          getSuppressEnter={() => suppressEnterUntilKeyUpRef.current}
          isComposing={isComposing}
          onPasteFiles={onPasteFiles}
          onMoveHighlightedIndex={moveHighlightedIndex}
          onSelectHighlightedMention={selectHighlightedMention}
          onSelectHighlightedSlashCommand={selectHighlightedSlashCommand}
          onSubmit={onSubmit}
          setSuppressEnter={next => {
            suppressEnterUntilKeyUpRef.current = next
          }}
          syncAutocomplete={() => updateAutocompleteTrigger()}
        />
      </LexicalComposer>
      {showSkillMenu && (
        <div
          ref={menuRef}
          data-testid="local-skill-autocomplete"
          role="listbox"
          className={[
            'absolute bottom-[calc(100%+0.5rem)] z-popover max-h-64 overflow-y-auto rounded-xl border border-border bg-background px-1.5 py-1.5 text-text-primary shadow-[0_12px_34px_rgba(0,0,0,0.12)]',
            skillMenuClassName,
          ].join(' ')}
        >
          <div className="px-2 pb-1 pt-0.5 text-xs font-normal leading-4 text-text-muted">
            {t('workbench.local_skills', '技能')}
          </div>
          {isMentionLoading ? (
            <div className="px-2.5 py-2 text-[13px] leading-[18px] text-text-muted">
              {t('workbench.loading_local_skills')}
            </div>
          ) : hasMentionLoadError ? (
            <button
              type="button"
              data-testid="local-skill-load-error"
              className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-5 text-text-muted hover:bg-muted"
              onClick={() => loadLocalMentions({ force: true })}
            >
              <Package className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate">{t('workbench.local_skills_error')}</span>
              <span
                data-testid="local-skill-retry-label"
                className="shrink-0 text-xs font-medium leading-5 text-text-secondary"
              >
                {t('workbench.retry_local_skills')}
              </span>
            </button>
          ) : filteredMentionCandidates.length === 0 ? (
            <div className="px-2.5 py-2 text-[13px] leading-[18px] text-text-muted">
              {t('workbench.no_local_skills')}
            </div>
          ) : (
            filteredMentionCandidates.map((candidate, index) => (
              <button
                key={candidate.key}
                type="button"
                data-testid={`${candidate.kind === 'app' ? 'local-app' : 'local-skill'}-option-${candidate.testId}`}
                aria-selected={index === highlightedIndex}
                role="option"
                disabled={!candidate.enabled}
                aria-disabled={!candidate.enabled}
                onMouseEnter={() => {
                  if (candidate.enabled) setSelectedIndex(index)
                }}
                onPointerEnter={() => {
                  if (candidate.enabled) setSelectedIndex(index)
                }}
                onClick={() => {
                  // eslint-disable-next-line react-hooks/refs -- refs are read when the click handler runs.
                  if (candidate.enabled) selectMentionCandidate(candidate)
                }}
                className={[
                  'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
                  index === highlightedIndex ? 'bg-muted' : '',
                ].join(' ')}
              >
                <Package className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="shrink-0 truncate text-[13px] font-medium leading-5 text-text-primary">
                    {candidate.title}
                  </span>
                  {candidate.description && (
                    <span className="min-w-0 truncate text-[13px] font-normal leading-5 text-text-muted">
                      {candidate.description}
                    </span>
                  )}
                </span>
                <span
                  data-testid={`local-skill-source-${candidate.testId}`}
                  className="shrink-0 text-xs leading-5 text-text-muted"
                >
                  {candidate.metaLabel}
                </span>
              </button>
            ))
          )}
        </div>
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
