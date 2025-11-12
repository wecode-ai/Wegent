// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useCallback } from 'react';
import { Modal, Input } from 'antd';
import { useTranslation } from 'react-i18next';
import type { MessageInstance } from 'antd/es/message/interface';

interface McpConfigImportModalProps {
  visible: boolean;
  onClose: () => void;
  onImport: (config: Record<string, unknown>, mode: 'replace' | 'append') => void;
  message: MessageInstance;
}

// Utility function to normalize MCP servers configuration
function normalizeMcpServers(config: Record<string, unknown>): Record<string, unknown> {
  const servers: Record<string, unknown> = (config.mcpServers ??
    config.mcp_servers ??
    config) as Record<string, unknown>;
  if (typeof servers !== 'object' || servers === null) {
    throw new Error('Invalid MCP servers configuration');
  }

  Object.keys(servers).forEach(key => {
    const server = servers[key] as Record<string, unknown>;
    if (server.transport) {
      server.type = server.transport;
      delete server.transport;
    }
    if (!server.type) {
      server.type = 'sse';
    }
  });

  return servers;
}

const McpConfigImportModal: React.FC<McpConfigImportModalProps> = ({
  visible,
  onClose,
  onImport,
  message,
}) => {
  const { t } = useTranslation('common');
  const [importConfig, setImportConfig] = useState('');
  const [importConfigError, setImportConfigError] = useState(false);
  const [importMode, setImportMode] = useState<'replace' | 'append'>('replace');

  // Handle import configuration confirmation
  const handleImportConfirm = useCallback(() => {
    const trimmed = importConfig.trim();
    if (!trimmed) {
      setImportConfigError(true);
      message.error(t('bot.errors.mcp_config_json'));
      return;
    }

    try {
      // Parse the imported configuration
      const parsed = JSON.parse(trimmed);
      // Normalize the MCP servers configuration
      const normalized = normalizeMcpServers(parsed);

      // Call parent component's import handler function
      onImport(normalized, importMode);

      // Reset state
      setImportConfig('');
      setImportConfigError(false);
    } catch (error) {
      setImportConfigError(true);
      if (error instanceof SyntaxError) {
        message.error(t('bot.errors.mcp_config_json'));
      } else {
        message.error(t('bot.errors.mcp_config_invalid'));
      }
    }
  }, [importConfig, importMode, message, onImport, t]);

  // Reset state when closing modal
  const handleCancel = () => {
    setImportConfig('');
    setImportConfigError(false);
    onClose();
  };

  return (
    <Modal
      title={t('bot.import_mcp_title')}
      open={visible}
      onOk={handleImportConfirm}
      onCancel={handleCancel}
      okText={t('actions.confirm')}
      cancelText={t('actions.cancel')}
    >
      <div className="mb-2">
        <p>{t('bot.import_mcp_desc')}</p>
        <div className="mt-2 mb-3">
          <div className="flex items-center space-x-4">
            <div className="flex items-center">
              <input
                type="radio"
                id="replace-mode"
                name="import-mode"
                value="replace"
                checked={importMode === 'replace'}
                onChange={() => setImportMode('replace')}
                className="mr-2"
              />
              <label htmlFor="replace-mode">{t('bot.import_mode_replace')}</label>
            </div>
            <div className="flex items-center">
              <input
                type="radio"
                id="append-mode"
                name="import-mode"
                value="append"
                checked={importMode === 'append'}
                onChange={() => setImportMode('append')}
                className="mr-2"
              />
              <label htmlFor="append-mode">{t('bot.import_mode_append')}</label>
            </div>
          </div>
        </div>
      </div>
      <Input.TextArea
        value={importConfig}
        onChange={e => {
          setImportConfig(e.target.value);
          setImportConfigError(false);
        }}
        placeholder={`{
  "mcpServers": {
    "remote-server": {
      "url": "http://127.0.0.1:9099/sse"
    },
    "weibo-search-mcp": {
      "transport": "streamable_http"
    },
    "EcoMCP-server": {
      "url": "http://example.com:9999/sse",
      "disabled": false,
      "alwaysAllow": []
    }
  }
}`}
        rows={10}
        className={importConfigError ? 'border-red-500' : ''}
      />
      {importConfigError && (
        <div className="text-red-500 mt-1">{t('bot.errors.mcp_config_json')}</div>
      )}
    </Modal>
  );
};

export default McpConfigImportModal;
