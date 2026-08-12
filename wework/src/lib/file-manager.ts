import type { TFunction } from 'i18next'
import { getPlatform } from './platform'

export function fileManagerRevealLabel(t: TFunction): string {
  const platform = getPlatform()
  if (platform === 'win') return t('workbench.show_in_explorer')
  if (platform === 'linux') return t('workbench.show_in_file_manager')
  return t('workbench.show_in_finder')
}

export function fileManagerAppLabel(t: TFunction): string {
  const platform = getPlatform()
  if (platform === 'win') return t('workbench.opener_explorer')
  if (platform === 'linux') return t('workbench.opener_file_manager')
  return t('workbench.opener_finder')
}

export function terminalAppLabel(t: TFunction): string {
  const platform = getPlatform()
  if (platform === 'win') return t('workbench.opener_windows_terminal')
  if (platform === 'linux') return t('workbench.opener_default_terminal')
  return t('workbench.opener_terminal')
}
