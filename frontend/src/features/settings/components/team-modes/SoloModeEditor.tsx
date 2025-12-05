// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RiRobot2Line, RiMagicLine } from 'react-icons/ri';
import { Plus } from 'lucide-react';
import { Bot, Team } from '@/types/api';
import { useTranslation } from '@/hooks/useTranslation';
import { getPromptBadgeStyle, type PromptBadgeVariant } from '@/utils/styles';
import { Tag } from '@/components/ui/tag';
import BotEdit, { AgentType, BotEditRef } from '../BotEdit';

export interface SoloModeEditorProps {
  bots: Bot[];
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>;
  selectedBotId: number | null;
  setSelectedBotId: React.Dispatch<React.SetStateAction<number | null>>;
  editingTeam: Team | null;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
  unsavedPrompts?: Record<string, string>;
  teamPromptMap?: Map<number, boolean>;
  onOpenPromptDrawer?: () => void;
  /** Callback to create a new bot (reuse TeamEdit's handler) - deprecated, now handled inline */
  onCreateBot?: () => void;
  /** List of allowed agent types for filtering when creating bots */
  allowedAgents?: AgentType[];
  /** Current team editing ID (0 = new team) */
  editingTeamId?: number;
  /** Ref to access BotEdit methods for external saving */
  botEditRef?: React.RefObject<BotEditRef | null>;
}

export default function SoloModeEditor({
  bots,
  setBots,
  selectedBotId,
  setSelectedBotId,
  toast,
  unsavedPrompts = {},
  teamPromptMap,
  onOpenPromptDrawer,
  allowedAgents,
  editingTeamId,
  botEditRef,
}: SoloModeEditorProps) {
  const { t } = useTranslation('common');

  // Calculate prompt summary (similar to BotTransfer)
  const promptSummary = React.useMemo<{ label: string; variant: PromptBadgeVariant }>(() => {
    if (selectedBotId === null) {
      return {
        label: t('team.prompts_tag_none'),
        variant: 'none',
      };
    }

    // Check unsaved prompts first
    const unsavedPrompt = unsavedPrompts[`prompt-${selectedBotId}`];
    const hasUnsavedContent = unsavedPrompt && unsavedPrompt.trim().length > 0;

    // Check teamPromptMap
    const hasConfigured = teamPromptMap ? teamPromptMap.get(selectedBotId) || false : false;

    if (hasUnsavedContent) {
      const countText = hasConfigured ? ` - ${t('team.prompts_tag_configured', { count: 1 })}` : '';
      return {
        label: `${t('team.prompts_tag_pending')}${countText}`,
        variant: 'pending',
      };
    }

    if (hasConfigured) {
      return {
        label: t('team.prompts_tag_configured', { count: 1 }),
        variant: 'configured',
      };
    }

    return {
      label: t('team.prompts_tag_none'),
      variant: 'none',
    };
  }, [selectedBotId, unsavedPrompts, teamPromptMap, t]);

  const promptSummaryStyle = React.useMemo(
    () => getPromptBadgeStyle(promptSummary.variant),
    [promptSummary.variant]
  );

  // Determine if this is a new team without a selected bot
  const isNewTeamWithoutBot = editingTeamId === 0 && selectedBotId === null;

  // State for inline bot creation mode - auto-enter for new teams
  const [isCreatingBot, setIsCreatingBot] = useState(isNewTeamWithoutBot);
  // Track bots IDs to detect new bot creation
  const prevBotIdsRef = useRef<Set<number>>(new Set(bots.map(b => b.id)));

  // Update isCreatingBot when editingTeamId or selectedBotId changes
  useEffect(() => {
    if (editingTeamId === 0 && selectedBotId === null) {
      setIsCreatingBot(true);
    }
  }, [editingTeamId, selectedBotId]);

  // Get the selected bot
  const selectedBot = useMemo(() => {
    if (selectedBotId === null) return null;
    return bots.find(b => b.id === selectedBotId) || null;
  }, [bots, selectedBotId]);

  // Handle bot selection change
  const handleBotChange = useCallback(
    (botId: number) => {
      setSelectedBotId(botId);
      setIsCreatingBot(false);
    },
    [setSelectedBotId]
  );

  // Handle create new bot - show inline creation form
  const handleCreateBot = useCallback(() => {
    setIsCreatingBot(true);
  }, []);

  // Handle bot edit close
  const handleBotEditClose = useCallback(() => {
    // No-op for solo mode - bot changes are saved with team
  }, []);

  // Handle bot creation close - just close the creation mode (used for cancel)
  const handleBotCreateClose = useCallback(() => {
    // This is called when BotEdit's onClose is triggered
    // We don't set isCreatingBot to false here because the useEffect will handle it
    // when a new bot is detected. If no new bot is created (e.g., validation failed),
    // we keep the creation mode open.
  }, []);

  // Handle cancel creation explicitly
  const handleCancelCreate = useCallback(() => {
    setIsCreatingBot(false);
  }, []);

  // Effect to detect new bot creation and auto-select it
  useEffect(() => {
    // Find any new bot that wasn't in the previous set
    const currentBotIds = new Set(bots.map(b => b.id));
    const newBotIds = bots.filter(b => !prevBotIdsRef.current.has(b.id));

    // If there's a new bot, select it and close creation mode
    if (newBotIds.length > 0) {
      // Select the first new bot (should be the one we just created)
      const newBot = newBotIds[0];
      setSelectedBotId(newBot.id);
      // Close creation mode if we were creating
      if (isCreatingBot) {
        setIsCreatingBot(false);
      }
    }

    // Update the ref for next comparison
    prevBotIdsRef.current = currentBotIds;
  }, [bots, isCreatingBot, setSelectedBotId]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Bot selector */}
      <div className="flex flex-col mb-4 flex-shrink-0">
        <div className="flex items-center mb-1">
          <label className="block text-lg font-semibold text-text-primary">
            {t('team.select_bot')} <span className="text-red-400">*</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={selectedBotId?.toString() ?? undefined}
            onValueChange={value => handleBotChange(Number(value))}
          >
            <SelectTrigger className="flex-1 min-h-[36px]">
              {selectedBotId !== null && selectedBot ? (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <RiRobot2Line className="w-4 h-4 text-text-muted flex-shrink-0" />
                  <span className="truncate">
                    {selectedBot.name}
                    <span className="text-text-muted text-xs ml-1">({selectedBot.shell_type})</span>
                  </span>
                </div>
              ) : (
                <SelectValue placeholder={t('team.select_bot_placeholder')} />
              )}
            </SelectTrigger>
            <SelectContent>
              {bots.length === 0 ? (
                <div className="p-2 text-center">
                  <Button
                    size="sm"
                    onClick={e => {
                      e.stopPropagation();
                      handleCreateBot();
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {t('bots.new_bot')}
                  </Button>
                </div>
              ) : (
                bots.map((b: Bot) => (
                  <SelectItem key={b.id} value={b.id.toString()}>
                    <div className="flex items-center w-full">
                      <div className="flex min-w-0 flex-1 items-center space-x-2">
                        <RiRobot2Line className="w-4 h-4 text-text-muted flex-shrink-0" />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block truncate max-w-[200px]">
                              {b.name}{' '}
                              <span className="text-text-muted text-xs">({b.shell_type})</span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{`${b.name} (${b.shell_type})`}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          {/* Create new bot button */}
          <Button variant="outline" size="sm" onClick={handleCreateBot} className="flex-shrink-0">
            <Plus className="h-4 w-4 mr-1" />
            {t('bots.new_bot')}
          </Button>
        </div>
        {/* Team prompt link - similar to BotTransfer style */}
        {selectedBotId !== null && onOpenPromptDrawer && (
          <div className="flex items-center gap-2 mt-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-primary hover:text-primary/80"
                  onClick={onOpenPromptDrawer}
                >
                  <RiMagicLine className="mr-1 h-4 w-4" />
                  {t('team.prompts_link')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('team.prompts_tooltip')}</p>
              </TooltipContent>
            </Tooltip>
            <Tag
              className="!m-0 !px-2 !py-0 text-xs leading-5"
              variant="default"
              style={promptSummaryStyle}
            >
              {promptSummary.label}
            </Tag>
          </div>
        )}
      </div>

      {/* Bot details / edit area */}
      <div className="flex-1 min-h-0 rounded-md border border-border bg-base overflow-hidden">
        {isCreatingBot ? (
          /* Show BotEdit component in creation mode */
          <div className="h-full overflow-auto">
            <BotEdit
              ref={botEditRef}
              bots={bots}
              setBots={setBots}
              editingBotId={0}
              cloningBot={null}
              onClose={handleBotCreateClose}
              toast={toast}
              embedded={true}
              readOnly={false}
              hideActions={true}
              onCancelEdit={handleCancelCreate}
              allowedAgents={allowedAgents}
            />
          </div>
        ) : selectedBotId !== null ? (
          /* Show BotEdit component in edit mode - bot saves with team */
          <div className="h-full overflow-auto">
            <BotEdit
              ref={botEditRef}
              bots={bots}
              setBots={setBots}
              editingBotId={selectedBotId}
              cloningBot={null}
              onClose={handleBotEditClose}
              toast={toast}
              embedded={true}
              readOnly={false}
              hideActions={true}
              allowedAgents={allowedAgents}
            />
          </div>
        ) : (
          /* No bot selected */
          <div className="flex items-center justify-center h-full text-text-muted">
            <div className="text-center">
              <RiRobot2Line className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p>{t('team.no_bot_selected')}</p>
              <Button variant="outline" size="sm" onClick={handleCreateBot} className="mt-4">
                <Plus className="h-4 w-4 mr-1" />
                {t('bots.new_bot')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
