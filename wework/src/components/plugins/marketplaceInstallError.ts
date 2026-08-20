type Translate = (key: string, defaultValue: string, options?: Record<string, unknown>) => string

function stripExecutorPrefix(message: string): string {
  return message.replace(/^codex_app_server_request_failed:\s*/i, '').trim() || message
}

/** Map Codex/App Server install or uninstall failures to user-facing copy. */
export function humanizeMarketplacePluginError(
  message: string,
  t: Translate,
  operation: 'install' | 'uninstall' = 'install'
): string {
  const trimmed = stripExecutorPrefix(message.trim())
  if (!trimmed) {
    return operation === 'uninstall'
      ? t('workbench.plugins_uninstall_failed', '卸载失败，请稍后重试')
      : t('workbench.plugins_install_failed', '安装失败，请稍后重试')
  }
  if (/disabled by admin/i.test(trimmed)) {
    return operation === 'uninstall'
      ? t(
          'workbench.plugins_uninstall_disabled_by_admin',
          '该插件已被 ChatGPT / Codex 工作区管理员禁用，请联系管理员后再卸载。'
        )
      : t(
          'workbench.plugins_install_disabled_by_admin',
          '该插件已被 ChatGPT / Codex 工作区管理员禁用，请联系管理员开通后再安装。'
        )
  }
  if (/chatgpt authentication required/i.test(trimmed)) {
    return operation === 'uninstall'
      ? t(
          'workbench.plugins_uninstall_chatgpt_auth_required',
          '卸载该远程插件需要先登录 ChatGPT / Codex 账号。'
        )
      : t(
          'workbench.plugins_install_chatgpt_auth_required',
          '安装该远程插件需要先登录 ChatGPT / Codex 账号。'
        )
  }
  if (/still installed after uninstall/i.test(trimmed)) {
    return t(
      'workbench.plugins_uninstall_still_installed',
      '卸载未完成，插件仍显示为已安装。OpenAI 官方远程插件需要已登录的 ChatGPT / Codex 账号，并确认网络可访问。'
    )
  }
  return trimmed
}

export function humanizeMarketplaceInstallError(message: string, t: Translate): string {
  return humanizeMarketplacePluginError(message, t, 'install')
}

export function humanizeMarketplaceUninstallError(message: string, t: Translate): string {
  return humanizeMarketplacePluginError(message, t, 'uninstall')
}
