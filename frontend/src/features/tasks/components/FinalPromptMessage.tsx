// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState } from 'react';
import { Button, message } from 'antd';
import { FiCopy, FiCheck, FiPlusCircle } from 'react-icons/fi';
import { GiMagicWand } from 'react-icons/gi';
import type { FinalPromptData } from '@/types/api';
import MarkdownEditor from '@uiw/react-markdown-editor';
import { useTheme } from '@/features/theme/ThemeProvider';
import { useTranslation } from '@/hooks/useTranslation';
import { taskApis } from '@/apis/tasks';
import { useTaskContext } from '../contexts/taskContext';
import { useRouter } from 'next/navigation';

interface FinalPromptMessageProps {
  data: FinalPromptData;
}

export default function FinalPromptMessage({ data }: FinalPromptMessageProps) {
  const { t } = useTranslation('chat');
  const { theme } = useTheme();
  const { selectedTeam, selectedRepo, selectedBranch, refreshTasks } = useTaskContext();
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);

  const handleCopy = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(data.prompt);
      } else {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = data.prompt;
        textarea.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      setCopied(true);
      message.success(t('clarification.prompt_copied') || 'Prompt copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy prompt:', err);
      message.error(t('clarification.copy_failed') || 'Failed to copy prompt');
    }
  };

  const handleCreateTask = async () => {
    if (!selectedTeam || !selectedRepo || !selectedBranch) {
      message.warning(
        t('clarification.select_context') || 'Please select Team, Repository and Branch first'
      );
      return;
    }

    setIsCreatingTask(true);

    try {
      // Create a new task with the final prompt
      const newTaskId = await taskApis.createTask();

      // Send the prompt as the first message
      await taskApis.sendTaskMessage({
        task_id: newTaskId,
        message: data.prompt,
        title: data.prompt.substring(0, 100),
        team_id: selectedTeam.id,
        git_url: selectedRepo.git_url,
        git_repo: selectedRepo.git_repo,
        git_repo_id: selectedRepo.git_repo_id,
        git_domain: selectedRepo.git_domain,
        branch_name: selectedBranch.name,
        prompt: data.prompt,
        task_type: 'code',
        batch: 0,
        user_id: 0,
        user_name: '',
      });

      message.success(t('clarification.task_created') || 'New task created successfully');

      // Refresh task list
      await refreshTasks();

      // Navigate to the new task
      router.push(`/code?taskId=${newTaskId}`);
    } catch (error) {
      console.error('Failed to create task:', error);
      message.error(t('clarification.task_creation_failed') || 'Failed to create new task');
    } finally {
      setIsCreatingTask(false);
    }
  };

  return (
    <div className="space-y-3 p-4 rounded-lg border-2 border-blue-500/50 bg-blue-500/10 shadow-lg">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <GiMagicWand className="w-5 h-5 text-blue-400" />
        <h3 className="text-base font-semibold text-blue-400">
          {t('clarification.final_prompt_title') || 'Final Requirement Prompt'}
        </h3>
      </div>

      {/* Prompt Content */}
      <div className="bg-surface/30 rounded p-3 border border-blue-500/20">
        <MarkdownEditor.Markdown
          source={data.prompt}
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
        <Button
          type="default"
          icon={copied ? <FiCheck className="w-4 h-4" /> : <FiCopy className="w-4 h-4" />}
          onClick={handleCopy}
          className={copied ? 'border-green-500 text-green-500' : ''}
        >
          {copied
            ? t('clarification.copied') || 'Copied'
            : t('clarification.copy_prompt') || 'Copy Prompt'}
        </Button>

        <Button
          type="primary"
          icon={<FiPlusCircle className="w-4 h-4" />}
          onClick={handleCreateTask}
          loading={isCreatingTask}
        >
          {t('clarification.create_task') || 'Create New Task with This Prompt'}
        </Button>
      </div>

      {/* Hint */}
      <div className="text-xs text-text-tertiary italic">
        {t('clarification.final_prompt_hint') ||
          'This is the refined requirement based on your answers. You can copy it or create a new code task directly.'}
      </div>
    </div>
  );
}
