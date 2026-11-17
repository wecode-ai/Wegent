// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { parseGitAccessFailure } from '@wegent/chat-core/git-access'
import type { CollaborationTranslate } from '../i18n'
import type { CollaborationExecutionEnvironmentConfig } from '../types'
import type { WorkspaceGitRepository, WorkspaceGitRepositoryRef } from '../ports/SharedWorkspaceApi'

export function repositoryKey(repository: WorkspaceGitRepositoryRef) {
  return `${repository.provider}::${repository.gitDomain}::${repository.fullName}`
}

export function environmentConfigurationSnapshot(config?: CollaborationExecutionEnvironmentConfig) {
  return JSON.stringify([
    config?.workspace_policy ?? 'git_worktree',
    (config?.repositories ?? []).map(repo => [
      repo.name,
      repo.url,
      repo.ref,
      repo.path,
      repo.primary,
    ]),
    (config?.setup_steps ?? []).map(step => [step.command, step.working_directory]),
  ])
}

export function environmentConfigurationConflictMessage(translate: CollaborationTranslate) {
  return translate(
    'todo.execution_environment_configuration_conflict',
    '配置已在别处更新，草稿尚未保存。载入最新配置会替换草稿；也可保留草稿并刷新版本，检查后再保存。保存会替换最新的执行环境配置。'
  )
}

// Device errors embed the executor's absolute paths and the whole git stderr;
// keep the stage prefix and git's decisive line, the full text stays in title.
const LEGACY_REPOSITORY_FREE_ERROR =
  'Execution environment must have exactly one primary repository'

export function executionEnvironmentErrorSummary(
  message: string,
  repositoryFree: boolean,
  translate: CollaborationTranslate
): string {
  const gitFailure = parseGitAccessFailure(message)
  if (gitFailure) {
    return translate(
      `common:workbench.git_access_${gitFailure.code.replaceAll('-', '_')}`,
      gitFailure.message,
      { domain: gitFailure.domain }
    )
  }
  if (repositoryFree && message.includes(LEGACY_REPOSITORY_FREE_ERROR)) {
    return translate(
      'todo.execution_environment_blank_workspace_upgrade_required',
      '当前设备的 Executor 不支持空白执行环境，请升级或重启 Executor 后重试；也可以先添加一个主代码仓库。'
    )
  }
  const fatalLines = message.match(/fatal: [^\n]+/g)
  if (!fatalLines?.length) {
    return message
  }
  const detail = fatalLines[fatalLines.length - 1]
  const stage = message.match(/^(Failed to [^:\n]+):/)
  return stage ? `${stage[1]}: ${detail}` : detail
}

// Short name used for both the display name and the clone directory, for
// example "wegent" for "wecode-ai/Wegent".
export function repositoryShortName(repository: WorkspaceGitRepository) {
  const segment = repository.fullName.split('/').filter(Boolean).pop() ?? repository.name
  return segment.replace(/\.git$/, '') || repository.name
}

export function repositoryShortNameFromUrl(url: string) {
  return (
    url
      .split(/[/:]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/, '') ?? ''
  )
}
