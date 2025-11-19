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
 * Normalize MCP type string (handle underscore vs hyphen variations)
 */
function normalizeMcpType(type: string): string {
  return type.replace(/_/g, '-').toLowerCase();
}

/**
 * Convert MCP configuration type based on target agent type
 *
 * @param mcpConfig - The MCP server configuration object
 * @param targetAgentType - The target agent type (ClaudeCode or Agno)
 * @returns Converted MCP configuration
 */
export function adaptMcpConfigForAgent(
  mcpConfig: Record<string, any>,
  targetAgentType: AgentType
): Record<string, any> {
  if (!mcpConfig || typeof mcpConfig !== 'object') {
    return mcpConfig;
  }

  const adaptedConfig: Record<string, any> = {};

  // Process each MCP server configuration
  for (const [serverName, serverConfig] of Object.entries(mcpConfig)) {
    if (!serverConfig || typeof serverConfig !== 'object') {
      adaptedConfig[serverName] = serverConfig;
      continue;
    }

    const config = { ...serverConfig };
    const currentType = normalizeMcpType(config.type || 'sse');

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
