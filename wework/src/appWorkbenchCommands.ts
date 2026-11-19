import {
  GO_BACK_COMMAND,
  GO_FORWARD_COMMAND,
  INCREASE_FONT_SIZE_COMMAND,
  DECREASE_FONT_SIZE_COMMAND,
  RESET_FONT_SIZE_COMMAND,
  OPEN_SETTINGS_COMMAND,
  OPEN_TERMINAL_COMMAND,
  TOGGLE_SIDEBAR_COMMAND,
  TOGGLE_SIDE_PANEL_COMMAND,
  TOGGLE_MODEL_SELECTOR_COMMAND,
  dispatchGoBackShortcut,
  dispatchGoForwardShortcut,
  dispatchOpenSettingsShortcut,
  dispatchOpenTerminalShortcut,
  dispatchToggleSidebarShortcut,
  dispatchToggleSidePanelShortcut,
  dispatchToggleModelSelectorShortcut,
  dispatchStepFontSizeShortcut,
  dispatchResetFontSizeShortcut,
} from '@/lib/keybindings'
import type { useTranslation } from '@/hooks/useTranslation'
import type { useDshClientContext } from '@/features/dsh-runtime/DshClientContext'
import { registerDshCommand, registerDshContext } from '@/features/dsh-runtime/dshExtensions'

export function registerAppWorkbenchCommands(
  dshContext: NonNullable<ReturnType<typeof useDshClientContext>>,
  t: ReturnType<typeof useTranslation>['t'],
  scope: { isDesktop: boolean; isElectron: boolean; isMainWindow: boolean; isPopoutWindow: boolean }
) {
  const { isDesktop, isElectron, isMainWindow, isPopoutWindow } = scope
  const commands = [
    {
      id: OPEN_TERMINAL_COMMAND,
      title: t('workbench.keyboard_shortcuts_open_terminal', '切换底部面板'),
      description: t(
        'workbench.keyboard_shortcuts_open_terminal_description',
        '显示或隐藏底部面板'
      ),
      handler: dispatchOpenTerminalShortcut,
    },
    {
      id: OPEN_SETTINGS_COMMAND,
      title: t('workbench.keyboard_shortcuts_open_settings', '打开设置'),
      description: t('workbench.keyboard_shortcuts_open_settings_description', '打开设置页面'),
      handler: dispatchOpenSettingsShortcut,
    },
    {
      id: GO_BACK_COMMAND,
      title: t('workbench.keyboard_shortcuts_go_back', '返回'),
      description: t('workbench.keyboard_shortcuts_go_back_description', '返回导航历史'),
      handler: dispatchGoBackShortcut,
    },
    {
      id: GO_FORWARD_COMMAND,
      title: t('workbench.keyboard_shortcuts_go_forward', '前进'),
      description: t('workbench.keyboard_shortcuts_go_forward_description', '前进导航历史'),
      handler: dispatchGoForwardShortcut,
    },
    {
      id: TOGGLE_SIDEBAR_COMMAND,
      title: t('workbench.keyboard_shortcuts_toggle_sidebar', '切换边栏'),
      description: t('workbench.keyboard_shortcuts_toggle_sidebar_description', '显示或隐藏边栏'),
      handler: dispatchToggleSidebarShortcut,
    },
    {
      id: TOGGLE_SIDE_PANEL_COMMAND,
      title: t('workbench.keyboard_shortcuts_toggle_side_panel', '切换侧边面板'),
      description: t(
        'workbench.keyboard_shortcuts_toggle_side_panel_description',
        '显示或隐藏侧边面板'
      ),
      handler: dispatchToggleSidePanelShortcut,
    },
    {
      id: TOGGLE_MODEL_SELECTOR_COMMAND,
      title: t('workbench.keyboard_shortcuts_toggle_model_selector', '选择模型'),
      description: t(
        'workbench.keyboard_shortcuts_toggle_model_selector_description',
        '打开或关闭当前输入区的模型选择器'
      ),
      handler: dispatchToggleModelSelectorShortcut,
    },
    {
      id: INCREASE_FONT_SIZE_COMMAND,
      title: t('workbench.keyboard_shortcuts_increase_font_size', '增大字号'),
      description: t(
        'workbench.keyboard_shortcuts_increase_font_size_description',
        '同时增大 UI 和代码字号'
      ),
      handler: () => dispatchStepFontSizeShortcut(1),
    },
    {
      id: DECREASE_FONT_SIZE_COMMAND,
      title: t('workbench.keyboard_shortcuts_decrease_font_size', '减小字号'),
      description: t(
        'workbench.keyboard_shortcuts_decrease_font_size_description',
        '同时减小 UI 和代码字号'
      ),
      handler: () => dispatchStepFontSizeShortcut(-1),
    },
    {
      id: RESET_FONT_SIZE_COMMAND,
      title: t('workbench.keyboard_shortcuts_reset_font_size', '重置字号'),
      description: t(
        'workbench.keyboard_shortcuts_reset_font_size_description',
        '将 UI 和代码字号恢复为默认值'
      ),
      handler: dispatchResetFontSizeShortcut,
    },
  ] as const
  const disposers = commands.map(command =>
    registerDshCommand(
      dshContext,
      {
        id: command.id,
        title: command.title,
        description: command.description,
        category: 'Wework',
      },
      command.handler
    )
  )
  disposers.push(
    registerDshContext(dshContext, 'wework.desktop', isDesktop),
    registerDshContext(dshContext, 'wework.electron', isElectron),
    registerDshContext(dshContext, 'wework.window.main', isMainWindow),
    registerDshContext(dshContext, 'wework.window.popout', isPopoutWindow)
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
