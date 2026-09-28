// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type UnifiedAgentRuntime = "Codex" | "ClaudeCode";

export interface UnifiedAgentModelRef {
  name: string;
  namespace?: string;
  type?: "public" | "user" | "group" | "runtime";
}

export interface UnifiedAgentSkillRef {
  isPublic: boolean;
  name: string;
  namespace: string;
  skillId: number;
}

export interface UnifiedAgentPluginRef {
  catalogSource?: "cloud" | "local" | "local_cloud";
  description?: string;
  displayName: string;
  id: string;
  marketplaceId: string;
  pluginName: string;
}

export type UnifiedAgentCapabilityMode = "follow_device" | "manual";

export interface UnifiedAgentDefinition {
  displayName: string;
  capabilityMode: UnifiedAgentCapabilityMode;
  mcpServers: Record<string, unknown>;
  model: UnifiedAgentModelRef;
  name: string;
  namespace: string;
  plugins: UnifiedAgentPluginRef[];
  runtime: UnifiedAgentRuntime;
  skills: UnifiedAgentSkillRef[];
  systemPrompt: string;
}

export function parseAgentCapabilityMode(
  value: unknown,
): UnifiedAgentCapabilityMode {
  return value === "manual" ? "manual" : "follow_device";
}

export function parseAgentMcpServers(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value || "{}");
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("MCP configuration must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function agentPluginBinding(
  plugin: UnifiedAgentPluginRef,
): UnifiedAgentPluginRef {
  return {
    id: plugin.id,
    pluginName: plugin.pluginName,
    marketplaceId: plugin.marketplaceId,
    displayName: plugin.displayName,
    ...(plugin.description ? { description: plugin.description } : {}),
  };
}
