// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { SystemInfoDisplayProps } from '../types'
import { MCP_STATUS_COLORS } from '../utils/constants'

/**
 * Component to display system information (model, tools, MCP servers, etc.)
 */
const SystemInfoDisplay = memo(function SystemInfoDisplay({
  subtype: _subtype,
  model,
  tools,
  mcpServers,
  permissionMode,
  cwd,
}: SystemInfoDisplayProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-1 text-xs text-text-tertiary">
      {/* Model information */}
      {model && (
        <div className="flex items-center gap-1">
          <span className="font-medium">{t('chat:thinking.system_model') || 'Model'}:</span>
          <span>{model}</span>
        </div>
      )}

      {/* Tools count */}
      {tools && Array.isArray(tools) && (
        <div className="flex items-center gap-1">
          <span className="font-medium">{t('chat:thinking.system_tools') || 'Tools'}:</span>
          <span>
            {tools.length} {t('chat:thinking.system_tools_available') || 'available'}
          </span>
        </div>
      )}

      {/* MCP Servers status */}
      {mcpServers && Array.isArray(mcpServers) && mcpServers.length > 0 && (
        <div className="flex items-center gap-1">
          <span className="font-medium">
            {t('chat:thinking.system_mcp_servers') || 'MCP Servers'}:
          </span>
          <div className="flex gap-2">
            {mcpServers.map((server, idx) => {
              const isConnected = server.status === 'connected'
              const statusColors = isConnected
                ? MCP_STATUS_COLORS.connected
                : MCP_STATUS_COLORS.disconnected

              return (
                <span
                  key={idx}
                  className={`px-1.5 py-0.5 rounded text-xs ${statusColors.bg} ${statusColors.text}`}
                >
                  {server.name}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Permission mode */}
      {permissionMode && (
        <div className="flex items-center gap-1">
          <span className="font-medium">
            {t('chat:thinking.system_permission') || 'Permission'}:
          </span>
          <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 text-xs">
            {permissionMode}
          </span>
        </div>
      )}

      {/* Working directory */}
      {cwd && cwd !== '/app/executor' && (
        <div className="flex items-center gap-1">
          <span className="font-medium">{t('chat:thinking.system_directory') || 'Directory'}:</span>
          <span className="text-xs">{cwd}</span>
        </div>
      )}
    </div>
  )
})

export default SystemInfoDisplay
