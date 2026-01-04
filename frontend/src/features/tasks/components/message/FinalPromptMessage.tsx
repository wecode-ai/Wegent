// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState } from 'react';
import { Copy, Check, Plus, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FinalPromptData, Team, GitRepoInfo, GitBranch } from '@/types/api';
import MarkdownEditor from '@uiw/react-markdown-editor';
import { useTheme } from '@/features/theme/ThemeProvider';
import { useTranslation } from '@/hooks/useTranslation';
import { useRouter } from 'next/navigation';
import { useToast } from '@/hooks/use-toast';

interface FinalPromptMessageProps {
  data: FinalPromptData;
  selectedTeam?: Team | null;
  selectedRepo?: GitRepoInfo | null;
  selectedBranch?: GitBranch | null;
}

export default function FinalPromptMessage({
  data,
  selectedTeam,
  selectedRepo,
  selectedBranch,
}: FinalPromptMessageProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { theme } = useTheme();
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        navigator.clipboard.writeText
      ) {
        await navigator.clipboard.writeText(data.final_prompt);
      } else {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = data.final_prompt;
        textarea.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      toast({
        title: t('chat:clarification.prompt_copied') || 'Prompt copied to clipboard',
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy prompt:', err);
      toast({
        variant: 'destructive',
        title: t('chat:clarification.copy_failed') || 'Failed to copy prompt',
      });
    }
  };

  const handleCreateTask = () => {
    if (!selectedTeam || !selectedRepo || !selectedBranch) {
      toast({
        title:
          t('chat:clarification.select_context') ||
          'Please select Team, Repository and Branch first',
      });
      return;
    }

    // Store prompt data in sessionStorage for the new task page
    const promptData = {
      prompt: data.final_prompt,
      teamId: selectedTeam.id,
      repoId: selectedRepo.git_repo_id,
      branch: selectedBranch.name,
      timestamp: Date.now(),
    };

    sessionStorage.setItem('pendingTaskPrompt', JSON.stringify(promptData));

    // Navigate to new task page
    router.push('/code');

    toast({
      title: t('chat:clarification.prompt_ready') || 'Navigating to new task page...',
    });
  };

  return (
    <div className="space-y-3 p-4 rounded-lg border-2 border-blue-500/50 bg-blue-500/10 shadow-lg">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <Star className="w-5 h-5 text-blue-400" />
        <h3 className="text-base font-semibold text-blue-400">
          {t('chat:clarification.final_prompt_title') || 'Final Requirement Prompt'}
        </h3>
      </div>

      {/* Prompt Content */}
      <div className="bg-surface/30 rounded p-3 border border-blue-500/20">
        <MarkdownEditor.Markdown
          source={data.final_prompt}
          style={{ background: 'transparent' }}
          wrapperElement={{ 'data-color-mode': theme }}
          components={{
            a: ({ href, children, ...props }) => (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            ),
          }}
        />
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-3 pt-2">
        <Button variant="ghost" onClick={handleCopy} className={copied ? 'text-green-500' : ''}>
          {copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
          {copied
            ? t('chat:clarification.copied') || 'Copied'
            : t('chat:clarification.copy_prompt') || 'Copy Prompt'}
        </Button>

        <Button variant="secondary" onClick={handleCreateTask}>
          <Plus className="w-4 h-4 mr-2" />
          {t('chat:clarification.create_task') || 'Create New Task with This Prompt'}
        </Button>
      </div>

      {/* Hint */}
      <div className="text-xs text-text-tertiary italic">
        {t('chat:clarification.final_prompt_hint') ||
          'This is the refined requirement based on your answers. You can copy it or create a new code task directly.'}
      </div>
    </div>
  );
}
