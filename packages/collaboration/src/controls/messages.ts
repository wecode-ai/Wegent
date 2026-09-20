export const composerMessages: Record<
  "zh-CN" | "en",
  Record<string, string>
> = {
  "zh-CN": {
    "composer.permission_mode": "权限模式",
    "composer.permission_mode_read_only": "只读",
    "composer.permission_mode_workspace": "工作区",
    "composer.permission_mode_full_access": "完整访问",
    "composer.permission_full_access_confirm_title": "启用完整访问？",
    "composer.permission_full_access_confirm_description":
      "Codex 将无需询问即可运行命令、访问网络，并读取、创建、修改或删除这台电脑任意位置的文件。",
    "composer.permission_full_access_files": "文件和文件夹",
    "composer.permission_full_access_files_description":
      "访问工作区之外的文件，并可创建、修改或删除它们",
    "composer.permission_full_access_terminal": "终端命令",
    "composer.permission_full_access_terminal_description":
      "运行命令、安装软件和更改系统设置",
    "composer.permission_full_access_network": "互联网和连接的应用",
    "composer.permission_full_access_network_description":
      "访问网站、发送数据并使用已启用的连接器",
    "composer.permission_full_access_risk":
      "这会显著增加数据丢失、敏感信息泄露、提示词注入和意外操作的风险。",
    "composer.permission_full_access_confirm": "确认启用",
  },
  en: {
    "composer.permission_mode": "Permission mode",
    "composer.permission_mode_read_only": "Read only",
    "composer.permission_mode_workspace": "Workspace",
    "composer.permission_mode_full_access": "Full access",
    "composer.permission_full_access_confirm_title": "Turn on Full access?",
    "composer.permission_full_access_confirm_description":
      "Codex will be able to run commands, use the internet, and read, create, edit, or delete files anywhere on this computer without asking.",
    "composer.permission_full_access_files": "Files and folders",
    "composer.permission_full_access_files_description":
      "Access files outside the workspace and create, edit, or delete them",
    "composer.permission_full_access_terminal": "Terminal commands",
    "composer.permission_full_access_terminal_description":
      "Run commands, install software, and change system settings",
    "composer.permission_full_access_network": "Internet and connected apps",
    "composer.permission_full_access_network_description":
      "Access websites, send data, and use enabled connectors",
    "composer.permission_full_access_risk":
      "This significantly increases the risk of data loss, sensitive information exposure, prompt injection, and unexpected actions.",
    "composer.permission_full_access_confirm": "Confirm",
  },
};
