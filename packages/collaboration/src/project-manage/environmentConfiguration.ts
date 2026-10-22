// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceGitRepositoryRef } from "../ports/SharedWorkspaceApi";

export function repositoryKey(repository: WorkspaceGitRepositoryRef) {
  return `${repository.provider}::${repository.gitDomain}::${repository.fullName}`;
}
