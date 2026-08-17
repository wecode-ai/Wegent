/** Map Codex/App Server install failures to user-facing copy. */
export function humanizeMarketplaceInstallError(
  message: string,
  t: (key: string, defaultValue: string, options?: Record<string, unknown>) => string
): string {
  const trimmed = message.trim()
  if (!trimmed) {
    return t('workbench.plugins_install_failed', '安装失败，请稍后重试')
  }
  if (/disabled by admin/i.test(trimmed)) {
    return t(
      'workbench.plugins_install_disabled_by_admin',
      '该插件已被 ChatGPT / Codex 工作区管理员禁用，请联系管理员开通后再安装。'
    )
  }
  if (/chatgpt authentication required/i.test(trimmed)) {
    return t(
      'workbench.plugins_install_chatgpt_auth_required',
      '安装该远程插件需要先登录 ChatGPT / Codex 账号。'
    )
  }
  // Drop the noisy executor prefix when the remainder is already readable.
  return trimmed.replace(/^codex_app_server_request_failed:\s*/i, '').trim() || trimmed
}
