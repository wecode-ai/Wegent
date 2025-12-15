// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Type Adapter Utility
 *
 * Handles type conversion between different agent platforms:
 * - ClaudeCode: supports sse, http, stdio
 * - Agno: supports sse, streamable-http, stdio
 */

export type ClaudeCodeMcpType = 'sse' | 'http' | 'stdio';
export type AgnoMcpType = 'sse' | 'streamable-http' | 'stdio';
export type AgentType = 'ClaudeCode' | 'Agno';

/**
 * Validate if a string is a valid AgentType
 *
 * @param value - The value to validate
 * @returns True if the value is a valid AgentType
 */
export function isValidAgentType(value: string): value is AgentType {
  return value === 'ClaudeCode' || value === 'Agno';
}

/**
 * Type mapping from ClaudeCode to Agno
 */
const CLAUDE_TO_AGNO_TYPE_MAP: Record<ClaudeCodeMcpType, AgnoMcpType> = {
  sse: 'sse',
  http: 'streamable-http',
  stdio: 'stdio',
};

/**
 * Type mapping from Agno to ClaudeCode
 */
const AGNO_TO_CLAUDE_TYPE_MAP: Record<AgnoMcpType, ClaudeCodeMcpType> = {
  sse: 'sse',
  'streamable-http': 'http',
  stdio: 'stdio',
};

/**
 * Normalize MCP type string to handle various format variations
 *
 * Supports multiple naming conventions:
 * - streamableHttp, streamablehttp, streamable_http, streamable-http → streamable-http
 * - SSE, sse, Sse → sse
 * - STDIO, stdio, Stdio → stdio
 * - HTTP, http, Http → http
 */
function normalizeMcpType(type: string): string {
  if (!type) return 'stdio';

  // Handle camelCase variants first: streamableHttp → streamable-http
  // Insert hyphen before capital letters that follow lowercase letters
  let normalized = type.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

  // Replace underscores with hyphens
  normalized = normalized.replace(/_/g, '-');

  // Handle specific variations for streamable-http
  // Match patterns like: streamablehttp, streamable-http, streamable_http
  if (normalized.includes('streamable')) {
    return 'streamable-http';
  }

  return normalized;
}

/**
 * Convert MCP configuration type based on target agent type
 *
 * @param mcpConfig - The MCP server configuration object
 * @param targetAgentType - The target agent type (ClaudeCode or Agno)
 * @returns Converted MCP configuration
 */
export function adaptMcpConfigForAgent(
  mcpConfig: Record<string, unknown>,
  targetAgentType: AgentType
): Record<string, unknown> {
  if (!mcpConfig || typeof mcpConfig !== 'object') {
    return mcpConfig;
  }

  const adaptedConfig: Record<string, unknown> = {};

  // Process each MCP server configuration
  for (const [serverName, serverConfig] of Object.entries(mcpConfig)) {
    if (!serverConfig || typeof serverConfig !== 'object') {
      adaptedConfig[serverName] = serverConfig;
      continue;
    }

    const config = { ...serverConfig } as Record<string, unknown>;
    const currentType = normalizeMcpType((config.type as string) || 'stdio');

    // Convert type based on target agent
    if (targetAgentType === 'Agno') {
      // Convert to Agno format
      const claudeType = currentType as ClaudeCodeMcpType;
      if (CLAUDE_TO_AGNO_TYPE_MAP[claudeType]) {
        config.type = CLAUDE_TO_AGNO_TYPE_MAP[claudeType];
      } else {
        // If not recognized, try to map from normalized type
        if (currentType === 'streamable-http') {
          config.type = 'streamable-http';
        } else {
          config.type = currentType;
        }
      }
    } else if (targetAgentType === 'ClaudeCode') {
      // Convert to ClaudeCode format
      const agnoType = currentType as AgnoMcpType;
      if (AGNO_TO_CLAUDE_TYPE_MAP[agnoType]) {
        config.type = AGNO_TO_CLAUDE_TYPE_MAP[agnoType];
      } else {
        // If not recognized, default to sse or keep as is
        if (currentType === 'http') {
          config.type = 'http';
        } else {
          config.type = currentType;
        }
      }
    }

    adaptedConfig[serverName] = config;
  }

  return adaptedConfig;
}

/**
 * Validate MCP type for a specific agent
 *
 * @param type - The MCP type to validate
 * @param agentType - The agent type
 * @returns True if the type is valid for the agent
 */
export function isValidMcpTypeForAgent(type: string, agentType: AgentType): boolean {
  const normalizedType = normalizeMcpType(type);

  if (agentType === 'ClaudeCode') {
    return ['sse', 'http', 'stdio'].includes(normalizedType);
  } else if (agentType === 'Agno') {
    return ['sse', 'streamable-http', 'stdio'].includes(normalizedType);
  }

  return false;
}

/**
 * Get supported MCP types for an agent
 *
 * @param agentType - The agent type
 * @returns Array of supported MCP types
 */
export function getSupportedMcpTypes(agentType: AgentType): string[] {
  if (agentType === 'ClaudeCode') {
    return ['sse', 'http', 'stdio'];
  } else if (agentType === 'Agno') {
    return ['sse', 'streamable-http', 'stdio'];
  }
  return [];
}
