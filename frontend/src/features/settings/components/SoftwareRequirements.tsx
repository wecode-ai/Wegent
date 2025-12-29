// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckIcon } from '@heroicons/react/24/outline';
import { useTranslation } from '@/hooks/useTranslation';

// Software requirement data structure
export interface SoftwareRequirement {
  name: string; // Software name (e.g., node, python, claude-code)
  command: string; // Check command (e.g., node --version)
  minVersion: string; // Minimum version requirement (e.g., 20.0.0)
  versionRegex?: string; // Version extraction regex (optional)
  required: boolean; // Whether it's required
  description?: string; // Software description (optional)
}

// Shell type to requirements mapping
const shellRequirements: Record<string, SoftwareRequirement[]> = {
  ClaudeCode: [
    {
      name: 'Node.js',
      command: 'node --version',
      minVersion: '20.0.0',
      required: true,
      description: 'JavaScript runtime for Claude Code CLI',
    },
    {
      name: 'Python',
      command: 'python --version',
      minVersion: '3.12.0',
      required: true,
      description: 'Python interpreter for agent execution',
    },
    {
      name: 'claude-code',
      command: 'claude --version',
      minVersion: '0.1.0',
      required: true,
      description: 'Claude Code CLI (recommended)',
    },
  ],
  Agno: [
    {
      name: 'Python',
      command: 'python --version',
      minVersion: '3.12.0',
      required: true,
      description: 'Python interpreter for agent execution',
    },
    {
      name: 'SQLite',
      command: 'sqlite3 --version',
      minVersion: '3.50.0',
      required: true,
      description: 'Database for local data storage',
    },
  ],
  Dify: [],
};

interface SoftwareRequirementsProps {
  shellType: string; // Shell type (e.g., ClaudeCode, Agno, Dify)
}

const SoftwareRequirements: React.FC<SoftwareRequirementsProps> = ({ shellType }) => {
  const { t } = useTranslation();
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  // Get requirements for the shell type
  const requirements = shellRequirements[shellType] || [];

  // No requirements to display
  if (requirements.length === 0) {
    return null;
  }

  // Copy command to clipboard
  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
      setTimeout(() => setCopiedCommand(null), 2000);
    } catch (error) {
      console.error('Failed to copy command:', error);
    }
  };

  return (
    <Card className="mt-4 p-4 bg-surface border-border">
      <h3 className="text-base font-medium mb-2 text-text-primary">
        {t('common:shells.software_requirements_title')}
      </h3>
      <p className="text-xs text-text-muted mb-3">
        {t('common:shells.software_requirements_hint')}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {requirements.map(req => (
          <div
            key={req.name}
            className="flex flex-col p-3 bg-muted rounded-lg hover:bg-hover transition-colors"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {req.required ? (
                  <Badge variant="error" className="text-xs shrink-0">
                    {t('common:shells.required')}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {t('common:shells.optional')}
                  </Badge>
                )}
                <span className="font-medium text-text-primary truncate">{req.name}</span>
              </div>
              <span className="text-text-muted text-xs shrink-0 ml-2">≥ {req.minVersion}</span>
            </div>
            {req.description && <p className="text-xs text-text-muted mb-2">{req.description}</p>}
            <div className="flex items-center gap-2">
              <code className="text-xs bg-code-bg px-2 py-1 rounded text-text-secondary flex-1 truncate">
                {req.command}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyCommand(req.command)}
                className="shrink-0 h-7 px-2"
                title={t('common:shells.copy_command')}
              >
                {copiedCommand === req.command ? (
                  <CheckIcon className="w-4 h-4 text-green-600" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                )}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

export default SoftwareRequirements;
