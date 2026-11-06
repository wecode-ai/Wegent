export const executorProjectGroups = [
  ["executor-device-chromium", "executor-chromium"],
  ["executor-stalled-chromium"],
];
export const executorProjects = executorProjectGroups.flat();

// Order specific boundaries before their shared owners. Unknown code fails closed.
export const sourceRules = [
  [
    /^docs\/(en|zh)\/wegent\/developer-guide\/collaboration-permissions\.md$/,
    ["auth", "collaboration"],
  ],
  [/^(docs\/|AGENTS\.md$|README|LICENSE|\.gitignore$|\.editorconfig$)/, []],
  [/^(frontend|wework)\/src\/i18n\//, []],
  [/^(?!wework\/e2e\/|frontend\/e2e\/).*\.(test|spec)\.[cm]?[jt]sx?$/, []],
  [
    /^(backend\/tests\/(?!e2e|integration)|executor\/tests\/|shared\/tests\/)/,
    [],
  ],
  [/^backend\/(e2e_checks\/|tests\/e2e\/.*knowledge)/, ["knowledge"]],
  [
    /^backend\/tests\/(e2e|integration)\/.*(attachment|artifact)/,
    ["workspace"],
  ],
  [
    /^backend\/tests\/(e2e|integration)\/.*(subscription|dingtalk_.*card)/,
    ["automation"],
  ],
  [/^backend\/tests\/integration\/device_/, ["devices"]],
  [/^backend\/tests\/integration\/runtime_/, ["runtime"]],
  [/^backend\/tests\/integration\/.*(issue|project)/, ["collaboration"]],
  [
    /^wework\/(electron\/.*(app-update|release-preparation)|src\/(features\/app-update|lib\/app-updater))/,
    ["release"],
  ],
  [
    /^(\.github\/|docker\/|scripts\/|package\.json$|pnpm-|backend-rs\/config\/routes\.toml$)/,
    ["all"],
  ],
  [
    /^wework\/.*(legacy-dsh-browser-auth|browser-agent-approvals|browser.*auth)/,
    ["browser", "auth", "desktop"],
  ],
  [/^wework\/dsh\/ui-git\//, ["workspace", "runtime"]],
  [
    /^wework\/dsh\/(connection-|coordination-runtime|plugin-runtime)/,
    ["stand-in", "plugins"],
  ],
  [/^wework\/dsh\/ui-automations\//, ["automation"]],
  [/^wework\/dsh\/ui-applications\//, ["browser"]],
  [/^wework\/dsh\//, ["plugins", "desktop"]],
  [/^wework\/src\/.*(StandIn|standIn|stand-in)/, ["stand-in"]],
  [
    /^wework\/src\/.*(ProjectCoordina|Issue|Collaboration|TaskBoard)/,
    ["collaboration"],
  ],
  [
    /^wework\/src\/(components\/plugins|features\/plugins|features\/dsh-plugins|api\/.*[Pp]lugin)/,
    ["plugins"],
  ],
  [
    /^wework\/src\/.*([Aa]ttachment|FilePreview|FileToolbar|WorkspacePanel|WorkspaceOpener|workspace-tabs|WorkspaceTab|workspaceTab)/,
    ["workspace"],
  ],
  [/^wework\/src\/.*([Bb]rowser|harness-app|[Ss]martApp)/, ["browser"]],
  [/^wework\/src\/.*([Mm]odel|[Bb]ot|[Tt]eam|[Ss]kill|project-ai)/, ["agents"]],
  [
    /^wework\/src\/.*([Dd]evice|cloud-devices|ConnectionsSettings)/,
    ["devices"],
  ],
  [/^wework\/src\/.*([Aa]utomation)/, ["automation"]],
  [/^wework\/src\/.*([Ll]ogin|[Aa]uth|[Pp]ermission)/, ["auth"]],
  [
    /^wework\/src\/(components\/chat|components\/layout\/BufferedChatInput|features\/reply-predictions)/,
    ["chat"],
  ],
  [
    /^wework\/src\/(features\/workbench|api\/runtime|api\/dsh\/executorTransport|api\/local\/localServices)/,
    ["chat", "runtime", "workspace"],
  ],
  [/^wework\/src\/(features\/workspace|lib\/local-workspace)/, ["workspace"]],
  [/^wework\/src\/(desktop|telemetry|features\/notifications)/, ["desktop"]],
  [
    /^wework\/electron\/.*(embedded-browser|browser-|workbench-dsh|workbench-runtime|dsh-runtime|desktop-runtime)/,
    ["browser", "desktop"],
  ],
  [
    /^wework\/electron\/.*(managed-executor|executor-runtime)/,
    ["runtime", "desktop"],
  ],
  [/^wework\/electron\/(src\/host|src\/main|src\/shell)/, ["desktop"]],
  [/^packages\/chat-core\//, ["chat", "runtime"]],
  [
    /^packages\/collaboration\/src\/(conversation|composer|markdown)\//,
    ["chat", "collaboration"],
  ],
  [/^packages\/collaboration\//, ["collaboration"]],
  [/^packages\/process-explorer\//, ["desktop"]],
  [
    /^executor\/src\/(local\/capabilities|local\/plugin|plugin_account_auth)/,
    ["plugins"],
  ],
  [
    /^executor\/src\/.*(stand_in|personal_stand_in|project_coordinat|connection_)/,
    ["stand-in", "collaboration"],
  ],
  [/^executor\/src\/(browser_mcp|agents\/codex\/browser)/, ["browser"]],
  [/^executor\/src\/local\/.*git/, ["workspace"]],
  [
    /^executor\/src\/.*(collaboration|project_router)/,
    ["collaboration", "runtime"],
  ],
  [
    /^executor\/src\/(runtime_work|task_runtime|stream|agents|process)/,
    ["runtime"],
  ],
  [/^executor_manager\//, ["runtime", "devices"]],
  [/^sdk\/(plugin-|dws-auth)/, ["plugins"]],
  [/^knowledge_(engine|runtime|doc_converter)\//, ["knowledge"]],
  [
    /^(backend\/app|backend-rs\/src)\/.*(knowledge|dingtalk_import|external_document)/,
    ["knowledge"],
  ],
  [
    /^(backend\/app|backend-rs\/src)\/.*(subscription|automation|notification_card)/,
    ["automation"],
  ],
  [
    /^(backend\/app|backend-rs\/src)\/.*(collaboration|project_coordination|project_chat|issue)/,
    ["collaboration"],
  ],
  [/^(backend\/app|backend-rs\/src)\/.*(plugin|connector)/, ["plugins"]],
  [/^backend\/app\/services\/chat\//, ["chat", "runtime"]],
  [
    /^(backend\/app|backend-rs\/src)\/.*(auth|permission|group_member)/,
    ["auth"],
  ],
  [
    /^(backend\/app|backend-rs\/src)\/.*(device|wework_runtime_namespace)/,
    ["devices"],
  ],
  [
    /^(backend\/app|backend-rs\/src)\/.*(attachment|deliver|workspace|cloud_project)/,
    ["workspace"],
  ],
  [
    /^(backend\/app|backend-rs\/src)\/.*(model|bot|team|ghost|shell|skill)/,
    ["agents"],
  ],
  [
    /^(backend\/app|backend-rs\/src)\/.*(execution|callback|task_store|responses|runtime)/,
    ["runtime", "workspace"],
  ],
  [/^backend\/app\/.*chat|^chat_shell\//, ["chat", "runtime"]],
  [
    /^frontend\/src\/.*(FilePreview|attachment|file-upload|open-wework|\/preview\/)/,
    ["workspace"],
  ],
  [/^frontend\/src\/.*(collaboration|issue|project)/, ["collaboration"]],
  [/^frontend\/src\/.*(knowledge|document)/, ["knowledge"]],
  [/^frontend\/src\/.*(subscription|automation)/, ["automation"]],
  [/^frontend\/src\/.*(auth|login|permission|sharing|admin\/users)/, ["auth"]],
  [/^frontend\/src\/.*(device)/, ["devices"]],
  [
    /^frontend\/src\/.*(model|bot|team|ghost|shell|skill|capability)/,
    ["agents"],
  ],
  [/^frontend\/src\/.*(chat|message|composer|markdown)/, ["chat"]],
  [/^frontend\/src\/.*task/, ["runtime", "workspace"]],
];

// These are existing independent commands, not new runners or replacement tests.
export const integrationChecks = {
  attachments: { features: ["workspace"], shards: [2, 3] },
  attachment_replication: { features: ["workspace"], shards: [3] },
  dingtalk_sync: { features: ["knowledge"], shards: [1] },
  device_registration: { features: ["devices"], shards: [1] },
  runtime_activity: { features: ["runtime"], shards: [1] },
  project_detachment: { features: ["collaboration"], shards: [1] },
  issue_assignment: { features: ["collaboration"], shards: [1] },
  dingtalk_cards: { features: ["automation", "chat"], shards: [1] },
  subscriptions: { features: ["automation"], shards: [1] },
  knowledge_team_gateway: { features: ["knowledge", "agents"], shards: [1] },
  knowledge_index: { features: ["knowledge"], shards: [4] },
  dingtalk_documents: { features: ["knowledge"], shards: [2] },
};

export function classifySource(path) {
  const rule = sourceRules.find(([pattern]) => pattern.test(path));
  return rule ? rule[1] : ["all"];
}

export function ciLabels(labels) {
  return [
    ...new Set(
      labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter((name) => name.startsWith("ci:")),
    ),
  ].sort();
}
