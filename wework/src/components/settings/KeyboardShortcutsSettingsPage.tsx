import { createLocalAppServices } from '@/api/local/localServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  COLLAPSE_READ_CONVERSATIONS_COMMAND,
  DECREASE_FONT_SIZE_COMMAND,
  getDefaultKeybindings,
  GO_BACK_COMMAND,
  GO_FORWARD_COMMAND,
  INCREASE_FONT_SIZE_COMMAND,
  keybindingFromKeyboardEvent,
  KEYBINDINGS_CHANGED_EVENT,
  mergeKeybindings,
  normalizeKeybinding,
  OPEN_SEARCH_COMMAND,
  OPEN_SETTINGS_COMMAND,
  OPEN_TERMINAL_COMMAND,
  RESET_FONT_SIZE_COMMAND,
  shortcutsAvailable,
  TOGGLE_MODEL_SELECTOR_COMMAND,
  TOGGLE_PRIORITY_FILTER_COMMAND,
  TOGGLE_SIDE_PANEL_COMMAND,
  TOGGLE_SIDEBAR_COMMAND,
} from '@/lib/keybindings'
import { isImeComposingEvent } from '@wegent/chat-core/ime'
import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { CornerDownLeft, Loader2, RotateCcw, Search } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { createKeyboardShortcutsResource } from './keyboardShortcutsResource'
import { SettingsPage, SettingsPageHeader } from './settings-ui'

const COMMAND_LABELS: Record<string, { label: string; description: string }> = {
  [OPEN_TERMINAL_COMMAND]: {
    label: 'keyboard_shortcuts_open_terminal',
    description: 'keyboard_shortcuts_open_terminal_description',
  },
  [OPEN_SETTINGS_COMMAND]: {
    label: 'keyboard_shortcuts_open_settings',
    description: 'keyboard_shortcuts_open_settings_description',
  },
  [OPEN_SEARCH_COMMAND]: {
    label: 'keyboard_shortcuts_open_search',
    description: 'keyboard_shortcuts_open_search_description',
  },
  [GO_BACK_COMMAND]: {
    label: 'keyboard_shortcuts_go_back',
    description: 'keyboard_shortcuts_go_back_description',
  },
  [GO_FORWARD_COMMAND]: {
    label: 'keyboard_shortcuts_go_forward',
    description: 'keyboard_shortcuts_go_forward_description',
  },
  [TOGGLE_SIDEBAR_COMMAND]: {
    label: 'keyboard_shortcuts_toggle_sidebar',
    description: 'keyboard_shortcuts_toggle_sidebar_description',
  },
  [TOGGLE_SIDE_PANEL_COMMAND]: {
    label: 'keyboard_shortcuts_toggle_side_panel',
    description: 'keyboard_shortcuts_toggle_side_panel_description',
  },
  [TOGGLE_MODEL_SELECTOR_COMMAND]: {
    label: 'keyboard_shortcuts_toggle_model_selector',
    description: 'keyboard_shortcuts_toggle_model_selector_description',
  },
  [TOGGLE_PRIORITY_FILTER_COMMAND]: {
    label: 'keyboard_shortcuts_toggle_priority_filter',
    description: 'keyboard_shortcuts_toggle_priority_filter_description',
  },
  [COLLAPSE_READ_CONVERSATIONS_COMMAND]: {
    label: 'collapse_read_conversations',
    description: 'keyboard_shortcuts_collapse_read_conversations_description',
  },
  [INCREASE_FONT_SIZE_COMMAND]: {
    label: 'keyboard_shortcuts_increase_font_size',
    description: 'keyboard_shortcuts_increase_font_size_description',
  },
  [DECREASE_FONT_SIZE_COMMAND]: {
    label: 'keyboard_shortcuts_decrease_font_size',
    description: 'keyboard_shortcuts_decrease_font_size_description',
  },
  [RESET_FONT_SIZE_COMMAND]: {
    label: 'keyboard_shortcuts_reset_font_size',
    description: 'keyboard_shortcuts_reset_font_size_description',
  },
}

function commandFallback(command: string): string {
  if (command === OPEN_SETTINGS_COMMAND) return '打开设置'
  if (command === OPEN_SEARCH_COMMAND) return '打开搜索'
  if (command === GO_BACK_COMMAND) return '返回'
  if (command === GO_FORWARD_COMMAND) return '前进'
  if (command === TOGGLE_SIDEBAR_COMMAND) return '切换边栏'
  if (command === TOGGLE_SIDE_PANEL_COMMAND) return '切换侧边面板'
  if (command === TOGGLE_MODEL_SELECTOR_COMMAND) return '选择模型'
  if (command === TOGGLE_PRIORITY_FILTER_COMMAND) return '切换优先级筛选'
  if (command === COLLAPSE_READ_CONVERSATIONS_COMMAND) return '收起已读会话'
  if (command === INCREASE_FONT_SIZE_COMMAND) return '增大字号'
  if (command === DECREASE_FONT_SIZE_COMMAND) return '减小字号'
  if (command === RESET_FONT_SIZE_COMMAND) return '重置字号'
  return command === OPEN_TERMINAL_COMMAND ? '切换底部面板' : command
}

function commandDescriptionFallback(command: string): string {
  if (command === OPEN_SETTINGS_COMMAND) return '打开设置页面'
  if (command === OPEN_SEARCH_COMMAND) return '打开搜索面板'
  if (command === GO_BACK_COMMAND) return '返回导航历史'
  if (command === GO_FORWARD_COMMAND) return '前进导航历史'
  if (command === TOGGLE_SIDEBAR_COMMAND) return '显示或隐藏边栏'
  if (command === TOGGLE_SIDE_PANEL_COMMAND) return '显示或隐藏侧边面板'
  if (command === TOGGLE_MODEL_SELECTOR_COMMAND) return '打开或关闭当前输入区的模型选择器'
  if (command === TOGGLE_PRIORITY_FILTER_COMMAND) return '显示或隐藏需要关注的任务'
  if (command === COLLAPSE_READ_CONVERSATIONS_COMMAND) return '在原有分组中收起其他已读且空闲的会话'
  if (command === INCREASE_FONT_SIZE_COMMAND) return '同时增大 UI 和代码字号'
  if (command === DECREASE_FONT_SIZE_COMMAND) return '同时减小 UI 和代码字号'
  if (command === RESET_FONT_SIZE_COMMAND) return '将 UI 和代码字号恢复为默认值'
  return command === OPEN_TERMINAL_COMMAND ? '显示或隐藏底部面板' : ''
}

function KeybindingPill({ value }: { value: string }) {
  return (
    <span className="inline-flex min-h-7 items-center rounded-full bg-muted px-2.5 text-sm font-medium leading-[18px] text-text-secondary">
      {value.split('+').map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex items-center">
          {index > 0 ? <span className="mx-0.5"> </span> : null}
          <KeybindingPart value={part} />
        </span>
      ))}
    </span>
  )
}

function KeybindingPart({ value }: { value: string }) {
  if (value === 'Command') return <span aria-label="Command">⌘</span>
  if (value === 'Shift') return <span aria-label="Shift">⇧</span>
  if (value === 'Control') return <span aria-label="Control">⌃</span>
  if (value === 'Alt') return <span aria-label="Option">⌥</span>
  if (value === 'Enter') return <CornerDownLeft className="h-3.5 w-3.5" aria-label="Enter" />
  if (value === 'Plus') return <span aria-label="Plus">+</span>
  if (value === 'Minus') return <span aria-label="Minus">−</span>
  return <span>{value}</span>
}

export function KeyboardShortcutsSettingsPage() {
  const { t } = useTranslation('common')
  const [resource] = useState(() => {
    const available = shortcutsAvailable()
    return createKeyboardShortcutsResource(
      () => createLocalAppServices().runtimeWorkApi,
      available,
      () => window.dispatchEvent(new CustomEvent(KEYBINDINGS_CHANGED_EVENT))
    )
  })
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
  const { overrides, loading } = state
  const [recordingCommand, setRecordingCommand] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const error =
    state.error === 'save'
      ? t('workbench.keyboard_shortcuts_save_failed', '快捷键保存失败')
      : state.error === 'load'
        ? t('workbench.keyboard_shortcuts_load_failed', '快捷键加载失败')
        : null

  const defaultBindings = useMemo(() => getDefaultKeybindings(), [])
  const bindings = useMemo(() => mergeKeybindings(overrides), [overrides])
  const filteredCommands = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase()
    if (!trimmedQuery) return defaultBindings
    return defaultBindings.filter(item => {
      const labels = COMMAND_LABELS[item.command]
      const label = t(`workbench.${labels.label}`, commandFallback(item.command)).toLowerCase()
      const description = t(
        `workbench.${labels.description}`,
        commandDescriptionFallback(item.command)
      ).toLowerCase()
      return (
        item.command.toLowerCase().includes(trimmedQuery) ||
        label.includes(trimmedQuery) ||
        description.includes(trimmedQuery)
      )
    })
  }, [query, t, defaultBindings])

  const saveOverride = async (command: string, key: string | null) => {
    if (await resource.save(command, key))
      setRecordingCommand(current => (current === command ? null : current))
  }
  useWindowEvent(
    'keydown',
    event => {
      if (!recordingCommand || isImeComposingEvent(event)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecordingCommand(null)
        return
      }
      if (resource.getSnapshot().saving.has(recordingCommand)) return
      const key = normalizeKeybinding(keybindingFromKeyboardEvent(event))
      if (!key || !key.includes('+')) return
      void saveOverride(recordingCommand, key)
    },
    { capture: true, enabled: recordingCommand !== null }
  )

  return (
    <SettingsPage data-testid="keyboard-shortcuts-settings-page">
      <SettingsPageHeader
        title={t('workbench.keyboard_shortcuts_title', '键盘快捷键')}
        description={t('workbench.keyboard_shortcuts_description', '管理当前设备上的本地快捷键')}
      />
      <div className="relative mb-6 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <ControlInput
          density="compact"
          data-testid="keyboard-shortcuts-search-input"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('workbench.keyboard_shortcuts_search', '搜索快捷键')}
          className="w-full pl-9 pr-3 leading-[18px]"
        />
      </div>
      <div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', '加载中...')}
          </div>
        ) : null}
        {error ? (
          <div
            data-testid="keyboard-shortcuts-error"
            className="mb-4 text-sm text-destructive wework:text-red-500"
          >
            {error}
          </div>
        ) : null}
        <div className="overflow-hidden rounded-lg border border-border">
          {filteredCommands.map(item => {
            const labels = COMMAND_LABELS[item.command]
            const currentKey = bindings[item.command]
            const saving = state.saving.has(item.command)
            const recording = recordingCommand === item.command
            return (
              <div
                key={item.command}
                data-testid={`keyboard-shortcut-row-${item.command}`}
                className="grid grid-cols-[minmax(0,1fr)_220px_72px] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary">
                    {t(`workbench.${labels.label}`, commandFallback(item.command))}
                  </div>
                  <div className="mt-0.5 text-xs leading-4 text-text-secondary">
                    {t(`workbench.${labels.description}`, commandDescriptionFallback(item.command))}
                  </div>
                </div>
                <div className="flex flex-col items-start gap-2">
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`keyboard-shortcut-record-${item.command}`}
                    onClick={() => setRecordingCommand(item.command)}
                    disabled={saving}
                    className="inline-flex min-h-8 items-center justify-start text-left disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {recording ? (
                      <span className="inline-flex min-h-7 items-center rounded-full bg-primary/10 px-2.5 text-sm font-medium leading-[18px] text-primary">
                        {t('workbench.keyboard_shortcuts_recording', '按下快捷键')}
                      </span>
                    ) : currentKey ? (
                      <KeybindingPill value={currentKey} />
                    ) : (
                      <span className="text-sm leading-[18px] text-text-muted">
                        {t('workbench.keyboard_shortcuts_unassigned', '未设置')}
                      </span>
                    )}
                  </ControlButton>
                  {item.secondaryKeys?.map(key => (
                    <KeybindingPill key={key} value={key} />
                  ))}
                </div>
                <div className="flex items-center justify-end gap-1">
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`keyboard-shortcut-reset-${item.command}`}
                    onClick={() => void saveOverride(item.command, item.defaultKey)}
                    disabled={saving}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
                    title={t('workbench.keyboard_shortcuts_reset', '恢复默认')}
                    aria-label={t('workbench.keyboard_shortcuts_reset', '恢复默认')}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                  </ControlButton>
                  <DeleteIconButton
                    type="button"
                    data-testid={`keyboard-shortcut-clear-${item.command}`}
                    onClick={() => void saveOverride(item.command, null)}
                    disabled={saving}
                    title={t('workbench.keyboard_shortcuts_clear', '清除')}
                    aria-label={t('workbench.keyboard_shortcuts_clear', '清除')}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </SettingsPage>
  )
}
