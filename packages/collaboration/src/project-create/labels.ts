// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationLocale } from "../i18n";
import type { ProjectCreateLabels } from "./types";

export const projectCreateLabels: Record<
  CollaborationLocale,
  ProjectCreateLabels
> = {
  "zh-CN": {
    title: "新建项目空间",
    name: "名称",
    namePlaceholder: "例如：Wegent V4",
    location: "保存位置",
    locationImmutable: "创建后不可更改",
    localLocation: "本地空间",
    localLocationDescription: "保存在当前设备，可接入 GitHub 或 GitLab Issues",
    cloudLocation: "云端空间",
    cloudLocationDescription: "保存在 Wegent 云端，可在不同设备访问",
    visibility: "项目可见性",
    privateVisibility: "私有",
    privateVisibilityDescription: "仅项目成员可访问",
    publicVisibility: "公开",
    publicVisibilityDescription: "所有登录用户可访问",
    publicVisibilityNotice:
      "公开项目可被所有已登录用户查看，请勿放置敏感信息。",
    taskProvider: "任务来源",
    builtInProvider: "内置任务",
    builtInLocalDescription: "保存在本机",
    builtInCloudDescription: "保存在云端",
    githubDescription: "读取 Issues",
    gitlabDescription: "读取 Issues",
    aitableProvider: "钉钉多维表格",
    aitableDescription: "同步表格记录",
    repository: "仓库地址",
    repositoryHint:
      "支持 HTTPS、SSH 或 owner/repository 格式；自托管地址会自动识别。",
    token: "访问令牌",
    optional: "可选",
    privateRepositoryToken: "私有仓库需要访问令牌",
    cloudTokenHint:
      "令牌会加密保存在 Wegent Backend，并安全下发给本地 Executor。",
    localTokenHint: "令牌会加密保存在当前设备，不会写入项目文件。",
    aitableUrl: "多维表格链接",
    aitablePlaceholder: "粘贴 alidocs.dingtalk.com 多维表格链接",
    aitableInvalid: "无法识别这个链接，请复制打开多维表格后的完整浏览器地址。",
    aitableHint: "将自动识别表格和当前数据表，无需查找内部 ID。",
    aitableRuntimeHint:
      "表格读写统一由本机 Executor 通过 DWS 执行。创建后连接钉钉账号，并确保该账号已获得此表格权限。",
    description: "说明",
    descriptionPlaceholder: "这个项目空间用于什么？",
    cancel: "取消",
    create: "创建项目",
    creating: "正在创建…",
    unavailableLocation: "所选项目空间位置当前不可用",
    repositoryRequired: "请输入仓库地址",
    repositoryInvalid: "请输入完整仓库地址，或使用 owner/repository 格式",
    githubRepositoryInvalid: "GitHub 仓库地址应包含 owner/repository",
    gitlabRepositoryInvalid: "GitLab 仓库地址应包含 group/project",
    createFailed: "创建项目空间失败",
  },
  en: {
    title: "New project space",
    name: "Name",
    namePlaceholder: "For example: Wegent V4",
    location: "Storage location",
    locationImmutable: "Cannot be changed after creation",
    localLocation: "Local space",
    localLocationDescription:
      "Stored on this device; supports GitHub or GitLab Issues",
    cloudLocation: "Cloud space",
    cloudLocationDescription:
      "Stored in Wegent Cloud and available across devices",
    visibility: "Project visibility",
    privateVisibility: "Private",
    privateVisibilityDescription: "Project members only",
    publicVisibility: "Public",
    publicVisibilityDescription: "All signed-in users",
    publicVisibilityNotice:
      "All signed-in users can view this project. Avoid sensitive data.",
    taskProvider: "Task source",
    builtInProvider: "Built-in tasks",
    builtInLocalDescription: "Stored locally",
    builtInCloudDescription: "Stored in the cloud",
    githubDescription: "Use Issues",
    gitlabDescription: "Use Issues",
    aitableProvider: "DingTalk AI Table",
    aitableDescription: "Synchronize table records",
    repository: "Repository",
    repositoryHint: "HTTPS, SSH, and owner/repository formats are supported.",
    token: "Access token",
    optional: "Optional",
    privateRepositoryToken: "Required for private repositories",
    cloudTokenHint:
      "The token is encrypted in Wegent Backend and securely sent to the executor.",
    localTokenHint:
      "The token is encrypted on this device and is not written to project files.",
    aitableUrl: "AI Table URL",
    aitablePlaceholder: "Paste an alidocs.dingtalk.com AI Table URL",
    aitableInvalid:
      "This URL could not be recognized. Copy the complete browser URL.",
    aitableHint: "The base and current table are detected automatically.",
    aitableRuntimeHint:
      "Table access runs through DWS on the local executor. Connect DingTalk after creation.",
    description: "Description",
    descriptionPlaceholder: "What is this project space for?",
    cancel: "Cancel",
    create: "Create project",
    creating: "Creating…",
    unavailableLocation: "The selected project location is unavailable",
    repositoryRequired: "Enter a repository address",
    repositoryInvalid:
      "Enter a complete repository URL or use owner/repository",
    githubRepositoryInvalid:
      "A GitHub repository must include owner/repository",
    gitlabRepositoryInvalid: "A GitLab repository must include group/project",
    createFailed: "Failed to create project space",
  },
};
