// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { PartialTemplateApplyError, TemplateConfigurationError } from './apply'

export const templateMessages = {
  'zh-CN': {
    optionalRuntimeConfiguration: '运行环境（可选）',
    chooseTemplate: '选择模板',
    backToTemplates: '返回模板列表',
    deferredRuntimeHint: '可稍后在项目设置中配置。',
    environmentOnline: '在线',
    title: '协作模板',
    destination: '选择模板使用位置',
    newProject: '创建新项目',
    existingProject: '选择已有项目',
    noProjects: '暂无可管理的项目，可以创建新项目。',
    loading: '正在加载…',
    manageRequired: '只有项目所有者或维护者可以应用模板。',
    executionEnvironment: '项目执行环境',
    chooseProjectEnvironment: '选择执行设备',
    configureProjectEnvironment: '配置项目执行设备（新标签页）',
    projectEnvironmentSetupHint:
      '还没有在线的项目执行设备。配置设备后，点击刷新即可继续，当前填写内容会保留。',
    environmentAuthorizationHint: '允许此项目使用所选设备，同时共享给所属分组。',
    selectExecutionEnvironment: '暂无可用设备，可先创建项目。',
    description: '把成熟的分工与流程，带进你的下一个项目。',
    discover: '发现模板',
    available: '可用模板',
    accountAvailable: '账号可用',
    capabilities: '我的能力',
    mine: '我的模板',
    search: '搜索协作模板',
    builtin: '内置可用',
    downloaded: '已下载',
    pending: '待同步',
    personal: '个人模板',
    offline: '内置模板和已下载模板可继续使用。连接后可获取更多模板。',
    refresh: '刷新',
    sync: '同步个人模板',
    import: '导入 YAML',
    export: '导出配置（YAML）',
    details: '查看模板',
    delete: '删除模板',
    deleteHint:
      '删除“{name}”？此操作不可撤销，不会影响已创建的项目和协作小组。已同步的模板将同时从账号和本机移除。',
    deleteConnectionRequired: '请连接云端后删除已同步的模板。',
    createFromTemplate: '从模板创建',
    clearSelection: '移除模板',
    configureSelection: '配置成员',
    confirmConfiguration: '确认配置',
    returnToProject: '返回项目',
    returnToTemplates: '返回模板列表',
    selectionSummary: '{groups} 个小组 · {roles} 个角色',
    selectionIncomplete: '还有角色未安排成员，请配置后创建。',
    use: '使用此模板',
    download: '下载并使用',
    cloudAdd: '添加到我的能力',
    cloudAdded: '已添加到我的能力',
    added: '模板已就绪',
    roles: '角色与分工',
    removeRole: '移除角色及其负责的阶段：{name}',
    keepLeader: '协作群需要保留负责人',
    stages: '工作流',
    version: '版本',
    author: '作者',
    official: 'Wegent 官方',
    close: '关闭',
    cancel: '取消',
    confirm: '确认',
    save: '保存到我的模板',
    saveTitle: '保存为协作模板',
    saveHint: '把当前协作方式保存下来，下次直接使用。',
    saveName: '模板名称',
    descriptionLabel: '适用场景',
    saving: '正在保存…',
    saved: '已保存到我的模板',
    saveOffline: '已保存在此设备，可继续离线使用。',
    saveOnline: '仅自己可见。可以在 Wework 和 Wegent 中使用。',
    publish: '发布到能力商店',
    publishConfirm: '确认发布',
    publishTitle: '分享协作模板',
    publishScope: '当前仅自己可见，确认发布后公开。',
    publishHint:
      '发布后，其他人可以在能力商店发现并添加此模板。请先检查说明中是否包含不适合公开的内容。',
    published: '模板已发布',
    importTitle: '导入协作模板',
    importHint: '打开共享的 YAML，预览后保存到“我的模板”。',
    file: '选择 YAML 文件',
    preview: '模板预览',
    invalid: '模板格式不正确，请检查配置内容。',
    sizeLimit: '支持 .yaml 和 .yml 文件，最大 1 MB。',
    noResults: '未找到模板',
    retry: '重试',
    more: '加载更多',
    failed: '操作未完成，请稍后重试；如仍失败，请联系项目维护者。',
    connectionFailed: '连接失败，请检查连接后重试。',
    authenticationExpired: '登录已失效，请重新登录后继续。',
    permissionDenied: '当前账号没有操作权限，请确认项目维护者权限后继续。',
    requestConflict: '项目配置已发生变化，请检查当前小组和自动分配规则后再试。',
    invalidConfiguration: '成员或阶段配置无效，请检查角色绑定和阶段负责人。',
    invalidMembers: '绑定成员不可用，请确认成员仍具有项目 Developer 或更高权限。',
    invalidStages: '阶段配置无效，请确认阶段负责人属于小组且不是小组负责人。',
    duplicateMembers: '小组成员不能重复，请调整角色绑定。',
    invalidLeader: '小组负责人必须属于小组成员，请调整角色绑定。',
    serverFailed: '服务端处理失败，请稍后重试；如仍失败，请联系项目维护者。',
    resourceUnavailable: '项目或绑定资源已不可用，请刷新项目并检查访问权限。',
    groupsNotStarted: '模板尚未开始创建，当前配置已保留。',
    groupsRejected: '创建请求已被拒绝，当前配置已保留，可调整后重试。',
    groupsCreated: '已创建小组：{names}。请在项目设置中检查未完成的配置，避免重复导入。',
    groupsObserved:
      '发现同名的新小组：{names}。尚不能确认是否由本次请求创建；请检查项目设置，避免重复导入。',
    agentsObserved:
      '发现与模板同名的新智能体，尚不能确认是否由本次请求创建。请检查项目设置，避免重复导入。',
    groupsUnknown:
      '尚不能确认创建请求是否已完成；请求可能仍在处理。请刷新状态或检查项目设置，避免重复导入。',
    groupsRefreshFailed:
      '无法刷新协作小组列表，尚不能确认完整状态。请在项目设置中核对配置，避免重复导入。',
    agentsUnknown: '尚不能确认智能体创建请求是否已完成。请刷新状态或检查项目设置，避免重复创建。',
    syncConflict: '模板尚未同步。请检查冲突，或另存为副本。',
    bindingsTitle: '确认协作配置',
    bindingsHint:
      '确认后，模板中的智能体和分工将在当前项目或分组内生效。未预配置的角色可在下方补充成员。',
    embeddedAgents: '应用时自动创建模板智能体并绑定角色，模型和工具使用当前执行环境的配置。',
    agentsCount: '将创建 {count} 个智能体并绑定角色。',
    environmentHint: '模型和工具使用当前执行环境的配置。',
    agentModel: '智能体使用的模型',
    chooseModel: '请选择模型',
    selectedModelHint: '运行环境和模型可稍后配置。',
    modelUnavailable: '所选模型已不可用，请刷新模型列表并重新选择。',
    noModels: '暂无可用模型。请在设置中添加模型，然后刷新此列表。',
    modelLoadFailed: '模型列表加载失败，请刷新后重试。',
    cloudModelsUnavailable: '云端模型暂时无法加载。你仍可选择本机模型，或刷新后重试。',
    defaultModelRequired: '请先为当前执行环境设置默认模型，再应用此模板。',
    destinationEnvironmentRequired:
      '项目没有可用的已授权执行设备，请在项目的执行环境设置中检查设备状态与授权。',
    destinationEnvironmentAmbiguous: '请选择本次应用模板使用的项目执行设备。',
    destinationDeviceRequired: '当前执行设备暂不可用，请先连接设备并确认账号可访问，再重试。',
    unsupportedAgent: '此智能体的运行时或多机器人配置无法完整保存为模板，请先调整智能体配置。',
    unavailableAgent: '无法读取小组中的智能体配置，请检查智能体是否可用及访问权限。',
    unsupportedPolicy: '云端分组无法保留模板中的执行策略，请在项目中直接应用此模板。',
    autoCreate: '自动创建',
    customizeMembers: '调整成员（可选）',
    choose: '选择成员或智能体',
    groupName: '小组名称',
    apply: '应用模板',
    unbound: '还有角色未安排成员，请补充。',
    duplicateGroup: '项目中已有这个小组名称，请换一个名称。',
    existingHint: '新增协作小组；已有任务和小组保持原样。',
    selected: '已选择模板',
    configuration: '配置共享',
    configurationHint: '复用已有的协作方式，也把当前配置分享给其他项目。',
    importProject: '导入协作模板',
    importProjectHint: '为项目添加一套新的分工与流程。选择模板、确认配置后即可使用。',
    exportHint:
      '下载配置文件，在其他设备或分组导入使用。文件包含智能体配置、分工与流程，不包含任务、讨论或连接凭据。',
    bindError: '负责人不能同时承担执行角色，请调整成员。',
    partial: '部分智能体或小组已添加。请检查当前配置后再继续，避免重复创建。',
  },
  en: {
    optionalRuntimeConfiguration: 'Runtime (optional)',
    chooseTemplate: 'Choose template',
    backToTemplates: 'Back to templates',
    deferredRuntimeHint: 'You can configure this later in project settings.',
    environmentOnline: 'Online',
    title: 'Collaboration templates',
    destination: 'Choose where to use this template',
    newProject: 'Create a new project',
    existingProject: 'Choose an existing project',
    noProjects: 'No manageable projects. You can create a new project.',
    loading: 'Loading…',
    manageRequired: 'Only project owners and maintainers can apply templates.',
    executionEnvironment: 'Project execution environment',
    chooseProjectEnvironment: 'Choose an execution device',
    configureProjectEnvironment: 'Configure project devices (new tab)',
    projectEnvironmentSetupHint:
      'No project device is online. Configure a device, then refresh to continue. Your current input is preserved.',
    environmentAuthorizationHint:
      'Allow this project to use selected devices and share them with its group.',
    selectExecutionEnvironment: 'No devices available. You can create the project first.',
    description: 'Bring proven roles and workflows into your next project.',
    discover: 'Discover',
    available: 'Available',
    accountAvailable: 'In your account',
    capabilities: 'My capabilities',
    mine: 'My templates',
    search: 'Search collaboration templates',
    builtin: 'Built in',
    downloaded: 'Downloaded',
    pending: 'Pending sync',
    personal: 'Personal template',
    offline: 'Built-in and downloaded templates remain available. Connect to find more templates.',
    refresh: 'Refresh',
    sync: 'Sync personal templates',
    import: 'Import YAML',
    export: 'Export configuration (YAML)',
    details: 'View template',
    delete: 'Delete template',
    deleteHint:
      'Delete “{name}”? This cannot be undone. Existing projects and collaboration groups are not affected. Synced templates will be removed from your account and this device.',
    deleteConnectionRequired: 'Connect to delete a synced template.',
    createFromTemplate: 'Create from template',
    clearSelection: 'Remove template',
    configureSelection: 'Configure members',
    confirmConfiguration: 'Confirm configuration',
    returnToProject: 'Back to project',
    returnToTemplates: 'Back to templates',
    selectionSummary: 'Groups: {groups} · Roles: {roles}',
    selectionIncomplete: 'Some roles need members. Configure them before creating the project.',
    use: 'Use template',
    download: 'Download and use',
    cloudAdd: 'Add to my capabilities',
    cloudAdded: 'Added to my capabilities',
    added: 'Template is ready',
    roles: 'Roles and responsibilities',
    removeRole: 'Remove role and its assigned stages: {name}',
    keepLeader: 'Keep the group coordinator',
    stages: 'Workflow',
    version: 'Version',
    author: 'Author',
    official: 'Wegent',
    close: 'Close',
    cancel: 'Cancel',
    confirm: 'Confirm',
    save: 'Save to my templates',
    saveTitle: 'Save as collaboration template',
    saveHint: 'Save this way of working to use again.',
    saveName: 'Template name',
    descriptionLabel: 'Use cases',
    saving: 'Saving…',
    saved: 'Saved to my templates',
    saveOffline: 'Saved on this device and available offline.',
    saveOnline: 'Private to you. Available in Wework and Wegent.',
    publish: 'Publish to marketplace',
    publishConfirm: 'Publish template',
    publishTitle: 'Share collaboration template',
    publishScope: 'Currently private to you. Confirm publication to make it public.',
    publishHint:
      'Others will be able to discover and add this template. Check that its text is suitable for sharing.',
    published: 'Template published',
    importTitle: 'Import collaboration template',
    importHint: 'Open a shared YAML file, preview it, then save to My templates.',
    file: 'Choose YAML file',
    preview: 'Template preview',
    invalid: 'Invalid template. Please check the configuration.',
    sizeLimit: 'Supports .yaml and .yml files up to 1 MB.',
    noResults: 'No templates found',
    retry: 'Retry',
    more: 'Load more',
    failed: 'The operation could not finish. Try again later or contact a project maintainer.',
    connectionFailed: 'Connection failed. Check your connection and try again.',
    authenticationExpired: 'Your login has expired. Sign in again to continue.',
    permissionDenied:
      'Your account does not have permission. Confirm project maintainer access to continue.',
    requestConflict:
      'Project configuration has changed. Check existing groups and task routing before trying again.',
    invalidConfiguration:
      'Invalid member or stage configuration. Check role bindings and stage assignees.',
    invalidMembers:
      'A bound member is unavailable. Confirm each member still has project Developer access or higher.',
    invalidStages:
      'Invalid stage configuration. Stage assignees must belong to the group and cannot be its coordinator.',
    duplicateMembers: 'Group members must be unique. Adjust the role bindings.',
    invalidLeader: 'The coordinator must belong to the group. Adjust the role bindings.',
    serverFailed:
      'The server could not process this request. Try again later or contact a project maintainer.',
    resourceUnavailable:
      'The project or a bound resource is unavailable. Refresh the project and check access.',
    groupsNotStarted: 'Template creation has not started. Your configuration is preserved.',
    groupsRejected: 'Creation was rejected. Your configuration is preserved; adjust it and retry.',
    groupsCreated:
      'Groups were created: {names}. Check unfinished configuration in project settings before importing again.',
    groupsObserved:
      'New groups with matching names were found: {names}. We cannot confirm which request created them. Check project settings before importing again.',
    agentsObserved:
      'New Agents with template names were found. We cannot confirm which request created them. Check project settings before importing again.',
    groupsUnknown:
      'Creation has not been confirmed and the request may still be processing. Refresh status or check project settings before importing again to avoid duplicates.',
    groupsRefreshFailed:
      'Could not refresh collaboration groups, so their full current state is unavailable. Check project settings before importing again to avoid duplicates.',
    agentsUnknown:
      'The Agent creation request may still be processing. Refresh status or check project settings before importing again to avoid duplicates.',
    syncConflict: 'Template not synced. Resolve the conflict or save a copy.',
    embeddedAgents:
      'Template Agents are created and bound automatically. Models and tools follow the execution environment.',
    agentsCount: 'Agents to create and bind to roles: {count}.',
    environmentHint: 'Models and tools follow the execution environment.',
    agentModel: 'Model for Agents',
    chooseModel: 'Choose a model',
    selectedModelHint: 'Execution environments and models can be configured later.',
    modelUnavailable:
      'The selected model is no longer available. Refresh the model list and choose again.',
    noModels: 'No models available. Add a model in Settings, then refresh this list.',
    modelLoadFailed: 'Could not load models. Refresh to try again.',
    cloudModelsUnavailable:
      'Cloud models could not be loaded. Choose a local model or refresh to try again.',
    defaultModelRequired:
      'Configure a default model in the current execution environment before applying this template.',
    destinationEnvironmentRequired:
      'No authorized execution device is available for this project. Check device status and access in the project execution environment settings.',
    destinationEnvironmentAmbiguous:
      'Choose the project execution device to use for this template.',
    destinationDeviceRequired:
      'The execution device is unavailable. Connect it and confirm that your account can access it, then try again.',
    unsupportedAgent:
      'This Agent runtime or multi-Bot configuration cannot be fully represented in a template. Adjust the Agent configuration first.',
    unavailableAgent:
      'Cannot read a group Agent definition. Check its availability and your access.',
    unsupportedPolicy:
      'Cloud groups cannot preserve the template execution settings. Apply it directly to a project instead.',
    autoCreate: 'Created automatically',
    customizeMembers: 'Customize members (optional)',
    bindingsTitle: 'Confirm collaboration setup',
    bindingsHint:
      'Confirm to create the template Agents and role assignments. Complete any roles that are not preconfigured below.',
    choose: 'Choose a member or agent',
    groupName: 'Group name',
    apply: 'Apply template',
    unbound: 'Choose a member for every role.',
    duplicateGroup: 'A group already uses this name. Choose another name.',
    existingHint: 'Adds collaboration groups and preserves existing tasks and groups.',
    selected: 'Template selected',
    configuration: 'Configuration sharing',
    configurationHint: 'Reuse a way of working, or share this configuration with other projects.',
    importProject: 'Import collaboration template',
    importProjectHint:
      'Add roles and a workflow to this project. Choose a template and confirm its members.',
    exportHint:
      'Download a configuration to import on another device or group. Includes roles and workflows, without tasks, discussions or credentials.',
    bindError: 'The coordinator cannot also execute a stage. Choose a different member.',
    partial:
      'Some Agents or groups were added. Check the current configuration before continuing to avoid duplicates.',
  },
} as const

export function templateFailureMessage(error: unknown, locale: 'zh-CN' | 'en'): string {
  const code = error instanceof Error ? error.message : ''
  const m = templateMessages[locale]
  if (code === 'template_model_default_unavailable') return m.defaultModelRequired
  if (code === 'template_model_unavailable') return m.modelUnavailable
  if (code === 'template_environment_unavailable') return m.destinationEnvironmentRequired
  if (code === 'template_environment_ambiguous') return m.destinationEnvironmentAmbiguous
  if (code === 'template_agent_multi_bot' || code === 'template_agent_runtime_unsupported')
    return m.unsupportedAgent
  if (code === 'template_agent_definition_unavailable') return m.unavailableAgent
  if (error instanceof PartialTemplateApplyError && error.cause) {
    return `${templateFailureMessage(error.cause, locale)} ${error.message}`
  }
  if (error instanceof TemplateConfigurationError) return error.message
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    const status = error.status
    const detail = 'detail' in error ? error.detail : undefined
    // Only known public API details are rendered; raw bodies may contain internal data.
    const reason = typeof detail === 'string' ? detail : code
    let message: string = m.failed
    if (status === 401) message = m.authenticationExpired
    else if (status === 403) message = m.permissionDenied
    else if (status === 404) message = m.resourceUnavailable
    else if (status === 409) {
      message =
        reason === 'Collaboration group name already exists in this owner scope'
          ? m.duplicateGroup
          : m.requestConflict
    } else if (status === 400 || status === 422) {
      message = templateValidationMessage(reason, detail, locale)
    } else if (status >= 500) message = m.serverFailed
    return `${message} (HTTP ${status})`
  }
  if (
    error instanceof TypeError &&
    /^(Failed to fetch|fetch failed|Load failed|NetworkError when attempting to fetch resource\.?)$/.test(
      code
    )
  )
    return m.connectionFailed
  return m.failed
}

function templateValidationMessage(
  reason: string,
  detail: unknown,
  locale: 'zh-CN' | 'en'
): string {
  const m = templateMessages[locale]
  switch (reason) {
    case 'Human is not available in this Project':
    case 'Human is not available in this Workspace':
    case 'Agent is not available in this Project':
    case 'Agent is not available in this Workspace':
      return m.invalidMembers
    case 'Collaboration group members must be unique':
      return m.duplicateMembers
    case 'Leader must be a member of the collaboration group':
      return m.invalidLeader
    case 'Collaboration group leader cannot execute a stage':
      return m.bindError
    case 'Collaboration group stage assignee must be a group member':
      return m.invalidStages
  }
  if (
    Array.isArray(detail) &&
    detail.some(
      issue =>
        issue && typeof issue === 'object' && Array.isArray(issue.loc) && issue.loc[1] === 'stages'
    )
  )
    return m.invalidStages
  return m.invalidConfiguration
}
