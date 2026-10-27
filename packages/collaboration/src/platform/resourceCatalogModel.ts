// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type ResourceSource = "local" | "cloud";
export type ResourceScope = "all" | "mine" | "shared";
export type ResourceCatalogKind = "agents" | "teams" | "devices";

export function runtimeLabel(runtime: string) {
  const labels: Record<string, string> = {
    claude_code: "Claude Code",
    codex: "Codex",
    openclaw: "OpenClaw",
  };
  return (
    labels[runtime] ??
    runtime
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ")
  );
}
