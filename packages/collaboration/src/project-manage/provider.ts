// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ProjectManageProject } from "./types";

export { repositoryProviderConfig } from "../project-create/projectProviderConfig";

export function repositoryAddress(project: ProjectManageProject): string {
  const repository =
    typeof project.provider_config.repository === "string"
      ? project.provider_config.repository
      : "";
  const defaultDomain =
    project.task_provider === "github" ? "github.com" : "gitlab.com";
  const domain =
    typeof project.provider_config.domain === "string"
      ? project.provider_config.domain
      : defaultDomain;
  return repository ? `https://${domain}/${repository}` : "";
}
