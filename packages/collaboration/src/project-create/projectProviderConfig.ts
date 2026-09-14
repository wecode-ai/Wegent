// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ProjectCreateProvider } from "./types";

type RepositoryProvider = Extract<ProjectCreateProvider, "github" | "gitlab">;

export type RepositoryProviderErrorCode =
  | "repository_required"
  | "repository_invalid"
  | "github_repository_invalid"
  | "gitlab_repository_invalid";

export class RepositoryProviderError extends Error {
  readonly code: RepositoryProviderErrorCode;

  constructor(code: RepositoryProviderErrorCode) {
    super(code);
    this.name = "RepositoryProviderError";
    this.code = code;
  }
}

export function repositoryProviderConfig(
  address: string,
  provider: RepositoryProvider,
): {
  repository: string;
  domain?: string;
  api_base?: string;
} {
  const value = address.trim();
  if (!value) throw new RepositoryProviderError("repository_required");

  const shorthand = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand) {
    return {
      repository: `${shorthand[1]}/${shorthand[2].replace(/\.git$/, "")}`,
    };
  }

  const ssh = value.match(/^git@([^:]+):(.+)$/);
  let domain: string;
  let pathname: string;
  if (ssh) {
    domain = ssh[1].toLowerCase();
    pathname = ssh[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new RepositoryProviderError("repository_invalid");
    }
    domain = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  }

  const repositoryPath = pathname.replace(/^\/+|\/+$/g, "");
  const repositoryWithoutPage =
    provider === "gitlab"
      ? (repositoryPath.split("/-/")[0] ?? repositoryPath)
      : repositoryPath;
  const repository = repositoryWithoutPage.replace(/\.git$/, "");
  const segments = repository.split("/").filter(Boolean);
  if (segments.length < 2 || (provider === "github" && segments.length !== 2)) {
    throw new RepositoryProviderError(
      provider === "github"
        ? "github_repository_invalid"
        : "gitlab_repository_invalid",
    );
  }

  const defaultDomain = provider === "github" ? "github.com" : "gitlab.com";
  if (domain === defaultDomain) return { repository };
  return {
    repository,
    domain,
    api_base:
      provider === "github"
        ? `https://${domain}/api/v3`
        : `https://${domain}/api/v4`,
  };
}
