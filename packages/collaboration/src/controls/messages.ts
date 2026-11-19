export const composerMessages: Record<
  "zh-CN" | "en",
  Record<string, string>
> = {
  "zh-CN": {
    "workbench.permission_mode": "权限模式",
    "workbench.permission_mode_read_only": "只读",
    "workbench.permission_mode_workspace": "工作区",
    "workbench.permission_mode_full_access": "完整访问",
    "workbench.command_approval_manual": "人工确认高危命令",
    "workbench.command_approval_manual_help": "每次由你决定是否执行",
    "workbench.command_approval_ai": "AI 审核高危命令",
    "workbench.command_approval_ai_help": "由 Codex 审核并决定是否执行",
    "workbench.command_approval_automatic": "自动执行高危命令",
    "workbench.command_approval_automatic_help": "无需逐次确认",
    "workbench.command_approval_title": "高危命令处理方式",
    "workbench.command_approval_confirm_description":
      "Codex 识别出的高危命令（例如强制删除文件）可以直接运行，可能造成不可恢复的数据丢失。",
    "workbench.permission_full_access_confirm_title": "启用完整访问？",
    "workbench.permission_full_access_confirm_description":
      "Codex 可以运行命令、访问网络，并读写或删除工作区外的文件。",
    "workbench.permission_full_access_risk":
      "完整访问可能造成数据丢失或敏感信息泄露。",
    "workbench.permission_full_access_confirm": "确认启用",
  },
  en: {
    "workbench.permission_mode": "Permission mode",
    "workbench.permission_mode_read_only": "Read only",
    "workbench.permission_mode_workspace": "Workspace",
    "workbench.permission_mode_full_access": "Full access",
    "workbench.command_approval_manual": "Confirm risky commands manually",
    "workbench.command_approval_manual_help": "You decide each time",
    "workbench.command_approval_ai": "Review risky commands with AI",
    "workbench.command_approval_ai_help": "Codex reviews and decides",
    "workbench.command_approval_automatic": "Run risky commands automatically",
    "workbench.command_approval_automatic_help": "No per-command confirmation",
    "workbench.command_approval_title": "Risky command handling",
    "workbench.command_approval_confirm_description":
      "Commands Codex identifies as risky, such as forcibly deleting files, can run immediately and may cause permanent data loss.",
    "workbench.permission_full_access_confirm_title": "Turn on Full access?",
    "workbench.permission_full_access_confirm_description":
      "Codex can run commands, use the internet, and read, write, or delete files outside the workspace.",
    "workbench.permission_full_access_risk":
      "Full access can cause data loss or expose sensitive information.",
    "workbench.permission_full_access_confirm": "Confirm",
  },
};
