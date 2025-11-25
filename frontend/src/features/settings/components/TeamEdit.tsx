// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Transfer } from '@/components/ui/transfer';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import Image from 'next/image';
import { Tag } from '@/components/ui/tag';
import { RiRobot2Line, RiMagicLine } from 'react-icons/ri';
import { Edit, Plus, Copy, Loader2 } from 'lucide-react';

import { Bot, Team } from '@/types/api';
import { createTeam, updateTeam } from '../services/teams';
import TeamEditDrawer from './TeamEditDrawer';
import { useTranslation } from '@/hooks/useTranslation';
import { getPromptBadgeStyle, type PromptBadgeVariant } from '@/utils/styles';

interface TeamEditProps {
  teams: Team[];
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>;
  editingTeamId: number;
  setEditingTeamId: React.Dispatch<React.SetStateAction<number | null>>;
  initialTeam?: Team | null;
  bots: Bot[];
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>; // Add setBots property
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
}

export default function TeamEdit(props: TeamEditProps) {
  const {
    teams,
    setTeams,
    editingTeamId,
    setEditingTeamId,
    initialTeam = null,
    bots,
    setBots,
    toast,
  } = props;

  const { t } = useTranslation('common');
  // Current editing object (0 means create new)
  const editingTeam: Team | null =
    editingTeamId === 0 ? null : teams.find(t => t.id === editingTeamId) || null;

  const formTeam = editingTeam ?? (editingTeamId === 0 ? initialTeam : null) ?? null;

  // Left column: Team Name, Mode, Description
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'pipeline' | 'route' | 'coordinate' | 'collaborate'>('pipeline');

  // Right column: LeaderBot (single select), Bots Transfer (multi-select)
  // Use string key for antd Transfer, stringify bot.id here
  const [selectedBotKeys, setSelectedBotKeys] = useState<React.Key[]>([]);
  const [leaderBotId, setLeaderBotId] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);

  // Bot editing related state
  const [editingBotDrawerVisible, setEditingBotDrawerVisible] = useState(false);
  const [editingBotId, setEditingBotId] = useState<number | null>(null);
  const [drawerMode, setDrawerMode] = useState<'edit' | 'prompt'>('edit');
  const [cloningBot, setCloningBot] = useState<Bot | null>(null);
  const lastDrawerClosedAtRef = useRef<number | null>(null);
  const wasDrawerOpenRef = useRef(false);

  // Store unsaved team prompts
  const [unsavedPrompts, setUnsavedPrompts] = useState<Record<string, string>>({});

  const teamPromptMap = useMemo(() => {
    const map = new Map<number, boolean>();
    if (editingTeam) {
      editingTeam.bots.forEach(bot => {
        map.set(bot.bot_id, !!bot.bot_prompt?.trim());
      });
    }
    Object.entries(unsavedPrompts).forEach(([key, value]) => {
      const id = Number(key.replace('prompt-', ''));
      if (!Number.isNaN(id)) {
        map.set(id, !!value?.trim());
      }
    });
    return map;
  }, [editingTeam, unsavedPrompts]);

  const promptSummary = useMemo<{ label: string; variant: PromptBadgeVariant }>(() => {
    let configuredCount = 0;
    teamPromptMap.forEach(value => {
      if (value) configuredCount += 1;
    });
    const unsavedHasContent = Object.values(unsavedPrompts).some(
      value => (value ?? '').trim().length > 0
    );

    if (unsavedHasContent) {
      const countText =
        configuredCount > 0
          ? ` - ${t('team.prompts_tag_configured', { count: configuredCount })}`
          : '';
      return {
        label: `${t('team.prompts_tag_pending')}${countText}`,
        variant: 'pending',
      };
    }

    if (configuredCount > 0) {
      return {
        label: t('team.prompts_tag_configured', { count: configuredCount }),
        variant: 'configured',
      };
    }

    return {
      label: t('team.prompts_tag_none'),
      variant: 'none',
    };
  }, [teamPromptMap, unsavedPrompts, t]);

  const configuredPromptBadgeStyle = useMemo(() => getPromptBadgeStyle('configured'), []);
  const promptSummaryStyle = useMemo(
    () => getPromptBadgeStyle(promptSummary.variant),
    [promptSummary.variant]
  );

  const handleBack = useCallback(() => {
    setEditingTeamId(null);
  }, [setEditingTeamId]);

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      const target = event.target as HTMLElement | null;
      if (editingBotDrawerVisible) return;

      // Ignore escape events that originate from or immediately after closing the bot drawer
      if (target?.closest('[data-team-edit-drawer="true"]')) return;
      if (lastDrawerClosedAtRef.current && Date.now() - lastDrawerClosedAtRef.current < 200) {
        return;
      }

      handleBack();
    };

    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [handleBack, editingBotDrawerVisible]);

  useEffect(() => {
    if (wasDrawerOpenRef.current && !editingBotDrawerVisible) {
      lastDrawerClosedAtRef.current = Date.now();
    }
    wasDrawerOpenRef.current = editingBotDrawerVisible;
  }, [editingBotDrawerVisible]);

  useEffect(() => {
    if (editingTeamId === 0 && initialTeam) {
      setUnsavedPrompts(prev => {
        if (Object.keys(prev).length > 0) {
          return prev;
        }
        const next: Record<string, string> = {};
        initialTeam.bots.forEach(bot => {
          next[`prompt-${bot.bot_id}`] = bot.bot_prompt || '';
        });
        return next;
      });
    }
  }, [editingTeamId, initialTeam]);

  // Each Mode's "description" and "boundary", including text and images (i18n)
  const MODE_INFO = useMemo(() => {
    // i18n keys
    const titleKey = `team_model.${mode}`;
    const descKey = `team_model_desc.${mode}`;

    // Image mapping by mode
    const imageMap: Record<typeof mode, string> = {
      pipeline: '/settings/sequential.png',
      route: '/settings/router.png',
      coordinate: '/settings/network.png',
      collaborate: '/settings/parallel.png',
    };

    return {
      info: {
        title: t(titleKey),
        desc: t(descKey),
        bullets: [],
        image: imageMap[mode],
      },
    };
  }, [mode, t]);

  // Reset form when initializing/switching editing object
  // Reset form when initializing/switching editing object
  useEffect(() => {
    if (formTeam) {
      setName(formTeam.name);
      const m =
        (formTeam.workflow?.mode as 'pipeline' | 'route' | 'coordinate' | 'collaborate') ||
        'pipeline';
      setMode(m);
      const ids = formTeam.bots.map(b => String(b.bot_id));
      setSelectedBotKeys(ids);
      const leaderBot = formTeam.bots.find(b => b.role === 'leader');
      setLeaderBotId(leaderBot?.bot_id ?? null);
    } else {
      setName('');
      setMode('pipeline');
      setSelectedBotKeys([]);
      setLeaderBotId(null);
    }
  }, [editingTeamId, formTeam]);

  // When bots change, only update bots-related state, do not reset name and mode
  useEffect(() => {
    if (formTeam) {
      const ids = formTeam.bots
        .filter(b => bots.some(bot => bot.id === b.bot_id))
        .map(b => String(b.bot_id));
      setSelectedBotKeys(ids);
      const leaderBot = formTeam.bots.find(
        b => b.role === 'leader' && bots.some(bot => bot.id === b.bot_id)
      );
      setLeaderBotId(leaderBot?.bot_id ?? null);
    }
  }, [bots, formTeam]);
  // Change Mode
  const handleModeChange = (newMode: 'pipeline' | 'route' | 'coordinate' | 'collaborate') => {
    setMode(newMode);
    setSelectedBotKeys([]);
  };
  // Get currently selected agent_name (from leader or selected bot)
  const selectedAgentName = useMemo(() => {
    // No agent_name restriction in pipeline mode
    if (mode === 'pipeline') return null;

    // If leader exists, use leader's agent_name first
    if (leaderBotId !== null) {
      const leaderBot = bots.find(b => b.id === leaderBotId);
      if (leaderBot) return leaderBot.agent_name;
    }

    // If no leader but selected bot exists, use first selected bot's agent_name
    if (selectedBotKeys.length > 0) {
      const firstSelectedBot = bots.find(b => String(b.id) === selectedBotKeys[0]);
      if (firstSelectedBot) return firstSelectedBot.agent_name;
    }

    // No selection, return null
    return null;
  }, [mode, leaderBotId, selectedBotKeys, bots]);

  const isClaudeCodeAgent = useCallback((agentName?: string | null) => {
    if (!agentName) return false;
    const normalized = agentName.trim().toLowerCase();
    return (
      normalized === 'claudecode' ||
      normalized === 'claude_code_agent' ||
      normalized === 'claudecodeagent'
    );
  }, []);

  const hasClaudeCodeBot = useMemo(() => {
    const leaderBot = leaderBotId != null ? bots.find(b => b.id === leaderBotId) : null;
    if (leaderBot && isClaudeCodeAgent(leaderBot.agent_name)) {
      return true;
    }
    return selectedBotKeys.some(key => {
      const bot = bots.find(b => String(b.id) === key);
      return bot ? isClaudeCodeAgent(bot.agent_name) : false;
    });
  }, [bots, leaderBotId, selectedBotKeys, isClaudeCodeAgent]);

  useEffect(() => {
    if (hasClaudeCodeBot && mode !== 'pipeline') {
      setMode('pipeline');
    }
  }, [hasClaudeCodeBot, mode]);

  // Data source for Transfer
  const transferData = useMemo(() => {
    return bots.map(b => ({
      key: String(b.id),
      title: b.name,
      description: b.agent_name,
      disabled:
        // In non-pipeline mode, disable options not matching agent_name if already selected
        mode !== 'pipeline' && selectedAgentName !== null && b.agent_name !== selectedAgentName,
    }));
  }, [bots, mode, selectedAgentName]);

  // Transfer change
  const onTransferChange = (
    targetKeys: string[],
    direction: 'left' | 'right',
    moveKeys: string[]
  ) => {
    if (direction === 'right') {
      setSelectedBotKeys([...new Set(selectedBotKeys.concat(moveKeys))]);
      return;
    }
    setSelectedBotKeys(targetKeys);
  };
  // Leader change
  const onLeaderChange = (botId: number) => {
    // If new leader is in selected bots, remove it from selected bots
    if (selectedBotKeys.some(k => Number(k) === botId)) {
      setSelectedBotKeys(prev => prev.filter(k => Number(k) !== botId));
    }

    setLeaderBotId(botId);

    // In non-pipeline mode, filter selected bots by new leader's agent_name
    if (mode !== 'pipeline') {
      const leaderBot = bots.find(b => b.id === botId);
      if (leaderBot) {
        // Filter out selected bots not matching agent_name
        setSelectedBotKeys(prev =>
          prev.filter(key => {
            const bot = bots.find(b => String(b.id) === key);
            return bot && bot.agent_name === leaderBot.agent_name;
          })
        );
      }
    }
  };

  const handleEditBot = useCallback((botId: number) => {
    setDrawerMode('edit');
    setCloningBot(null);
    setEditingBotId(botId);
    setEditingBotDrawerVisible(true);
  }, []);

  const handleCreateBot = useCallback(() => {
    setDrawerMode('edit');
    setCloningBot(null);
    setEditingBotId(0);
    setEditingBotDrawerVisible(true);
  }, []);

  const handleCloneBot = useCallback(
    (botId: number) => {
      const botToClone = bots.find(b => b.id === botId);
      if (!botToClone) {
        return;
      }
      setDrawerMode('edit');
      setCloningBot(botToClone);
      setEditingBotId(0);
      setEditingBotDrawerVisible(true);
    },
    [bots]
  );
  // Validate agent_name consistency (required in non-pipeline mode)
  const validateAgentNameConsistency = (ids: number[]) => {
    const selected = bots.filter(b => ids.includes(b.id));
    const agentNames = Array.from(new Set(selected.map(b => b.agent_name)));
    return agentNames.length <= 1;
  };

  // Save
  // Save
  const handleSave = async () => {
    if (!name.trim()) {
      toast({
        variant: 'destructive',
        title: 'Team name is required',
      });
      return;
    }
    if (leaderBotId == null) {
      toast({
        variant: 'destructive',
        title: 'Leader bot is required',
      });
      return;
    }
    const selectedIds = selectedBotKeys.map(k => Number(k));

    // Non-pipeline mode requires agent_name consistency
    if (mode !== 'pipeline') {
      if (!validateAgentNameConsistency(selectedIds)) {
        toast({
          variant: 'destructive',
          title: 'Only bots with the same agent_name can be selected in non-Pipeline mode',
        });
        return;
      }
    }
    // Assemble bots data (per-step prompt not supported, all prompts empty)
    // Ensure leader bot is first, others follow transfer order
    const allBotIds: number[] = [];

    // Add leader bot first (if any)
    if (leaderBotId !== null) {
      allBotIds.push(leaderBotId);
    }

    // Then add other bots, avoid duplicate leader bot
    selectedIds.forEach(id => {
      if (id !== leaderBotId) {
        allBotIds.push(id);
      }
    });

    // Create botsData, keep allBotIds order, retain original bot_prompt or use unsaved prompts
    const botsData = allBotIds.map(id => {
      // If editing existing team, keep bot_prompt if bot_id exists
      const existingBot = formTeam?.bots.find(b => b.bot_id === id);
      // Check for unsaved prompt
      const unsavedPrompt = unsavedPrompts[`prompt-${id}`];

      return {
        bot_id: id,
        bot_prompt: unsavedPrompt || existingBot?.bot_prompt || '',
        role: id === leaderBotId ? 'leader' : undefined,
      };
    });

    const workflow = { mode, leader_bot_id: leaderBotId };

    setSaving(true);
    try {
      if (editingTeam && editingTeamId && editingTeamId > 0) {
        const updated = await updateTeam(editingTeamId, {
          name: name.trim(),
          workflow,
          bots: botsData,
        });
        setTeams(prev => prev.map(team => (team.id === updated.id ? updated : team)));
      } else {
        const created = await createTeam({
          name: name.trim(),
          workflow,
          bots: botsData,
        });
        setTeams(prev => [created, ...prev]);
      }
      // Clear unsaved prompts
      setUnsavedPrompts({});
      setEditingTeamId(null);
    } catch (error) {
      toast({
        variant: 'destructive',
        title:
          (error as Error)?.message ||
          (editingTeam ? 'Failed to edit team' : 'Failed to create team'),
      });
    } finally {
      setSaving(false);
    }
  };

  // Leader dropdown options, filter by agent_name in non-pipeline mode
  const leaderOptions = useMemo(() => {
    // Show all bots in pipeline mode
    if (mode === 'pipeline') return bots;

    // If non-pipeline mode and selected bot exists
    if (selectedBotKeys.length > 0) {
      // Find first selected bot
      const firstSelectedBot = bots.find(b => String(b.id) === selectedBotKeys[0]);
      if (firstSelectedBot) {
        // Show only bots with same agent_name
        return bots.filter(b => b.agent_name === firstSelectedBot.agent_name);
      }
    }

    // Show all bots if no selected bot
    return bots;
  }, [bots, mode, selectedBotKeys]);

  const handleTeamUpdate = (updatedTeam: Team) => {
    setTeams(prev => prev.map(t => (t.id === updatedTeam.id ? updatedTeam : t)));
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 items-stretch bg-surface rounded-lg pt-0 pb-4 relative w-full max-w-none px-0 md:px-4 overflow-hidden">
      {/* Top toolbar: Back + Save */}
      <div className="w-full flex items-center justify-between mb-4 mt-4 flex-shrink-0 px-4 md:px-0">
        <button
          onClick={handleBack}
          className="flex items-center text-text-muted hover:text-text-primary text-base"
          title={t('common.back')}
        >
          <svg
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="mr-1"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t('common.back')}
        </button>

        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {saving ? (editingTeam ? t('actions.saving') : t('actions.creating')) : t('actions.save')}
        </Button>
      </div>

      {/* Two-column layout: Left (Name, Mode, Description Image), Right (LeaderBot, Bots Transfer) */}
      <div className="w-full flex flex-col lg:flex-row gap-6 items-stretch flex-1 py-0 min-h-0 px-4 md:px-0 overflow-hidden">
        {/* Left column */}
        <div className="w-full lg:w-2/5 xl:w-1/3 min-w-0 flex flex-col space-y-5 min-h-0 flex-shrink-0">
          {/* Team Name */}
          <div className="flex flex-col">
            <div className="flex items-center mb-1">
              <label className="block text-lg font-semibold text-text-primary">
                {t('team.name')} <span className="text-red-400">*</span>
              </label>
            </div>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('team.name_placeholder')}
              className="w-full px-4 py-1 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent text-base h-9"
            />
          </div>

          {/* Mode component */}
          <div className="flex flex-col">
            <div className="flex items-center mb-1">
              <label className="block text-lg font-semibold text-text-primary">
                {t('team.model')} <span className="text-red-400">*</span>
              </label>
            </div>

            {/* Integrate Mode selection and description into one container */}
            <div className="rounded-md border border-border bg-base p-4 flex flex-col flex-1 min-h-0">
              {/* Mode selection */}
              <div className="mb-3">
                <RadioGroup
                  value={mode}
                  onValueChange={value =>
                    handleModeChange(value as 'pipeline' | 'route' | 'coordinate' | 'collaborate')
                  }
                  className="w-full grid grid-cols-4 gap-2"
                >
                  {['pipeline', 'route', 'coordinate', 'collaborate'].map(opt => (
                    <div key={opt} className="flex items-center">
                      <RadioGroupItem
                        value={opt}
                        id={`mode-${opt}`}
                        disabled={hasClaudeCodeBot && opt !== 'pipeline'}
                        className="peer sr-only"
                      />
                      <label
                        htmlFor={`mode-${opt}`}
                        className={`
                          flex items-center justify-center w-full px-3 py-1.5 text-sm font-medium
                          rounded-md cursor-pointer transition-colors
                          border border-border
                          ${hasClaudeCodeBot && opt !== 'pipeline' ? 'opacity-50 cursor-not-allowed' : ''}
                          peer-data-[state=checked]:bg-primary peer-data-[state=checked]:text-primary-foreground peer-data-[state=checked]:border-primary
                          hover:bg-accent hover:text-accent-foreground
                        `}
                      >
                        {t(`team_model.${opt}`)}
                      </label>
                    </div>
                  ))}
                </RadioGroup>
              </div>

              {/* Divider */}
              <div className="border-t border-border my-2"></div>

              {/* Mode description */}
              <div className="flex-1 flex flex-col min-h-0">
                <p className="text-sm text-text-secondary">{MODE_INFO.info.desc}</p>

                {MODE_INFO.info.bullets.length > 0 && (
                  <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-text-secondary">
                    {MODE_INFO.info.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}

                <div className="pt-3 rounded-md overflow-hidden flex-1 min-h-0 flex items-stretch justify-start">
                  <Image
                    src={MODE_INFO.info.image}
                    alt={MODE_INFO.info.title}
                    width={640}
                    height={360}
                    className="object-contain w-full h-full max-h-full"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="w-full lg:w-3/5 xl:w-2/3 min-w-0 flex flex-col space-y-5 min-h-0">
          <div className="rounded-md border border-border bg-base p-4 flex flex-col flex-1 min-h-0">
            {/* LeaderBot single select */}
            <div className="flex flex-col">
              <div className="flex items-center mb-1">
                <label className="block text-lg font-semibold text-text-primary">
                  {t('team.leader')} <span className="text-red-400">*</span>
                </label>
              </div>
              <Select
                value={leaderBotId?.toString() ?? undefined}
                onValueChange={value => onLeaderChange(Number(value))}
              >
                <SelectTrigger className="w-full min-h-[36px]">
                  {leaderBotId !== null ? (
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <RiRobot2Line className="w-4 h-4 text-text-muted flex-shrink-0" />
                        <span className="truncate max-w-[200px]">
                          {bots.find(b => b.id === leaderBotId)?.name || ''}
                          <span className="text-text-muted text-xs ml-1">
                            ({bots.find(b => b.id === leaderBotId)?.agent_name || ''})
                          </span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                        <Edit
                          className="h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                          onPointerDown={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleEditBot(leaderBotId);
                          }}
                        />
                        <Copy
                          className="h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                          onPointerDown={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleCloneBot(leaderBotId);
                          }}
                        />
                      </div>
                    </div>
                  ) : (
                    <SelectValue placeholder={t('team.select_leader')} />
                  )}
                </SelectTrigger>
                <SelectContent>
                  {leaderOptions.length === 0 ? (
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
                    leaderOptions.map((b: Bot) => (
                      <SelectItem key={b.id} value={b.id.toString()}>
                        <div className="flex items-center w-full">
                          <div className="flex min-w-0 flex-1 items-center space-x-2">
                            <RiRobot2Line className="w-4 h-4 text-text-muted flex-shrink-0" />
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="block truncate max-w-[200px]">
                                  {b.name}{' '}
                                  <span className="text-text-muted text-xs">({b.agent_name})</span>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{`${b.name} (${b.agent_name})`}</p>
                              </TooltipContent>
                            </Tooltip>
                            {teamPromptMap.get(b.id) && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Tag
                                    className="!m-0 !ml-1 !px-1.5 !py-0 text-[11px] leading-4"
                                    variant="default"
                                    style={configuredPromptBadgeStyle}
                                  >
                                    {t('team.prompts_badge')}
                                  </Tag>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>{t('team.prompts_badge_tooltip')}</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                          <div className="flex items-center gap-3 ml-3">
                            <Edit
                              className="h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                              onPointerDown={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleEditBot(b.id);
                              }}
                            />
                            <Copy
                              className="h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                              onPointerDown={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleCloneBot(b.id);
                              }}
                            />
                          </div>
                        </div>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Bots Transfer - consolidated container */}
            <div className="flex flex-col min-h-0 mt-1">
              <div className="flex items-center justify-between mb-1">
                <label className="block text-lg font-semibold text-text-primary">
                  {t('team.bots')}
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-primary hover:text-primary/80"
                      onClick={() => {
                        setDrawerMode('prompt');
                        setEditingBotDrawerVisible(true);
                      }}
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

              {/* Transfer component with flex-1 to fill remaining space */}
              <div className="relative flex-1 min-h-0">
                <Transfer
                  dataSource={transferData.filter(item => Number(item.key) !== leaderBotId)}
                  targetKeys={selectedBotKeys.map(String)}
                  onChange={onTransferChange}
                  render={item => (
                    <div className="flex items-center justify-between w-full">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="truncate max-w-[150px]">
                            {item.title}
                            <span className="text-xs text-text-muted">({item.description})</span>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{`${item.title} (${item.description})`}</p>
                        </TooltipContent>
                      </Tooltip>

                      <div className="flex items-center">
                        {teamPromptMap.get(Number(item.key)) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Tag
                                className="!m-0 !mr-2 !px-1.5 !py-0 text-[11px] leading-4"
                                variant="default"
                                style={configuredPromptBadgeStyle}
                              >
                                {t('team.prompts_badge')}
                              </Tag>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{t('team.prompts_badge_tooltip')}</p>
                            </TooltipContent>
                          </Tooltip>
                        )}

                        <Edit
                          className="ml-2 h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                          onClick={e => {
                            e.stopPropagation(); // Stop event propagation to avoid triggering selection
                            handleEditBot(Number(item.key));
                          }}
                        />
                        <Copy
                          className="ml-3 h-4 w-4 text-muted-foreground hover:text-foreground cursor-pointer"
                          onClick={e => {
                            e.stopPropagation();
                            handleCloneBot(Number(item.key));
                          }}
                        />
                      </div>
                    </div>
                  )}
                  titles={[t('team.candidates'), t('team.in_team')]}
                  className="h-full transfer-fill"
                  listStyle={{
                    backgroundColor: 'rgb(var(--color-bg-surface))',
                    borderColor: 'rgb(var(--color-border))',
                  }}
                  leftFooter={
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={handleCreateBot}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      {t('bots.new_bot')}
                    </Button>
                  }
                />
              </div>
            </div>
          </div>
          {/* Mobile Transfer layout optimization styles */}
          <style
            dangerouslySetInnerHTML={{
              __html: `
              @media (max-width: 1024px) {
                /* Stack layout on tablet */
                .flex.flex-col.lg\\:flex-row {
                  flex-direction: column !important;
                }
                .w-full.lg\\:w-2\\/5.xl\\:w-1\\/3 {
                  width: 100% !important;
                  margin-bottom: 1rem;
                }
                .w-full.lg\\:w-3\\/5.xl\\:w-2\\/3 {
                  width: 100% !important;
                }
              }

              @media (max-width: 640px) {
                /* Mobile Transfer layout optimization */
                .ant-transfer {
                  display: flex !important;
                  flex-direction: column !important;
                  gap: 16px !important;
                  align-items: stretch !important;
                  max-width: 100vw !important;
                  overflow-x: hidden !important;
                }
                .ant-transfer .ant-transfer-list {
                  width: 100% !important;
                  flex: 1 !important;
                  min-height: 200px !important;
                  max-height: 300px !important;
                  max-width: 100% !important;
                  overflow-x: hidden !important;
                  box-sizing: border-box !important;
                }
                .ant-transfer .ant-transfer-operation {
                  order: 0 !important;
                  justify-content: center !important;
                  align-items: center !important;
                  padding: 12px 0 !important;
                  background-color: transparent !important;
                  flex-direction: row !important;
                  gap: 8px !important;
                  max-width: 100% !important;
                  overflow-x: hidden !important;
                }
                .ant-transfer .ant-transfer-operation .ant-btn {
                  margin: 0 4px !important;
                  min-width: 40px !important;
                  height: 40px !important;
                  flex-shrink: 0 !important;
                }

                /* Mobile layout adjustments */
                .flex.flex-col.flex-1.min-h-0.items-stretch.bg-surface.rounded-lg {
                  padding: 0.25rem !important;
                  border-radius: 0.5rem !important;
                  max-width: 100vw !important;
                  overflow-x: hidden !important;
                }

                /* Prevent horizontal scroll on mobile */
                body, html {
                  overflow-x: hidden !important;
                }

                /* Adjust input and select sizes */
                input[type="text"] {
                  font-size: 16px !important;
                  padding: 0.75rem 1rem !important;
                  height: auto !important;
                  max-width: 100% !important;
                  box-sizing: border-box !important;
                }

                .ant-select {
                  max-width: 100% !important;
                }

                .ant-select-selector {
                  min-height: 40px !important;
                  font-size: 16px !important;
                  max-width: 100% !important;
                  box-sizing: border-box !important;
                }

                .ant-select-dropdown {
                  max-width: 90vw !important;
                  min-width: 200px !important;
                }

                /* Adjust button sizes */
                .ant-btn {
                  min-height: 40px !important;
                  font-size: 14px !important;
                  padding: 8px 16px !important;
                  max-width: 100% !important;
                  white-space: nowrap !important;
                  overflow: hidden !important;
                  text-overflow: ellipsis !important;
                  flex-shrink: 0 !important;
                }

                /* Adjust labels */
                label {
                  font-size: 16px !important;
                  max-width: 100% !important;
                  word-wrap: break-word !important;
                }

                /* Reduce spacing on mobile */
                .space-y-5 > * + * {
                  margin-top: 1rem !important;
                }

                /* Fix overflow issues */
                .overflow-hidden {
                  overflow-x: hidden !important;
                  overflow-y: auto !important;
                }

                .min-h-0 {
                  min-height: 0 !important;
                  min-width: 0 !important;
                }

                /* Fix flex container overflow */
                .flex.flex-col {
                  min-width: 0 !important;
                  max-width: 100% !important;
                }

                .flex-grow {
                  min-width: 0 !important;
                  max-width: 100% !important;
                }

                /* Adjust Radio buttons for mobile */
                .ant-radio-button-wrapper {
                  padding: 0 8px !important;
                  font-size: 14px !important;
                  height: 36px !important;
                  line-height: 34px !important;
                  flex-shrink: 0 !important;
                  min-width: 60px !important;
                }

                .ant-radio-group {
                  flex-wrap: wrap !important;
                  max-width: 100% !important;
                  overflow-x: hidden !important;
                }

                /* Adjust Image container */
                .pt-3.rounded-md.overflow-hidden.flex-1.min-h-0.flex.items-stretch.justify-start {
                  min-height: 200px !important;
                  max-height: 300px !important;
                  max-width: 100% !important;
                  overflow: hidden !important;
                }

                img {
                  max-width: 100% !important;
                  height: auto !important;
                  object-fit: contain !important;
                }

                /* Adjust padding for mobile */
                .rounded-md.border.border-border.bg-base.p-4 {
                  padding: 1rem !important;
                  max-width: 100% !important;
                  box-sizing: border-box !important;
                }

                /* Fix Transfer component scroll */
                .ant-transfer-list-body {
                  overflow-y: auto !important;
                  max-height: 200px !important;
                  overflow-x: hidden !important;
                }

                .ant-transfer-list-content {
                  overflow-x: hidden !important;
                }

                .ant-transfer-list-content-item {
                  max-width: 100% !important;
                  overflow-x: hidden !important;
                }

                /* Adjust Tag sizes */
                .ant-tag {
                  font-size: 12px !important;
                  padding: 2px 6px !important;
                  line-height: 18px !important;
                  max-width: 100% !important;
                  overflow: hidden !important;
                  text-overflow: ellipsis !important;
                  white-space: nowrap !important;
                }

                /* Fix Select dropdown */
                .ant-select-dropdown {
                  font-size: 16px !important;
                  max-width: 90vw !important;
                }

                .ant-select-dropdown .ant-select-item {
                  max-width: 100% !important;
                  overflow: hidden !important;
                  text-overflow: ellipsis !important;
                  white-space: nowrap !important;
                }

                /* Adjust tooltips for mobile */
                .ant-tooltip-inner {
                  font-size: 14px !important;
                  padding: 8px 12px !important;
                  max-width: 80vw !important;
                  word-wrap: break-word !important;
                  white-space: normal !important;
                }

                /* Fix long text in transfer items */
                .ant-transfer-list-content-item-text {
                  max-width: calc(100% - 40px) !important;
                  overflow: hidden !important;
                  text-overflow: ellipsis !important;
                  white-space: nowrap !important;
                }

                /* Fix container widths */
                .w-full {
                  max-width: 100vw !important;
                  overflow-x: hidden !important;
                }

                .max-w-none {
                  max-width: 100vw !important;
                  overflow-x: hidden !important;
                }
              }
            `,
            }}
          />

          {/* Desktop and responsive styles */}
          <style
            dangerouslySetInnerHTML={{
              __html: `
      /* Global overflow prevention */
      * {
        box-sizing: border-box !important;
      }

      /* Ensure Transfer component doesn't overflow horizontally on mobile */
      @media (max-width: 640px) {
        .ant-transfer-list {
          max-width: 100% !important;
          overflow-x: hidden !important;
          box-sizing: border-box !important;
        }
        /* Mobile: Limit list body height to avoid taking full screen */
        .ant-transfer-list-body {
          overflow-y: auto !important;
          max-height: 200px !important;
          overflow-x: hidden !important;
        }
        /* Ensure minimum height for Transfer container */
        .transfer-fill {
          min-height: 400px !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
        }
      }

      /* Desktop: equal widths and no overflow */
      @media (min-width: 1025px) {
        .ant-transfer {
          align-items: stretch !important;
          height: 400px !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
        }
        .ant-transfer .ant-transfer-list {
          width: calc(50% - 24px) !important;
          height: 400px !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
          box-sizing: border-box !important;
        }
        .ant-transfer .ant-transfer-operation {
          padding: 0 8px !important;
        }
        .ant-transfer .ant-transfer-list-header {
          padding: 6px 10px !important;
          overflow-x: hidden !important;
        }
      }

      /* PC Transfer fixed height and scroll */
      @media (min-width: 1025px) {
        /* Set fixed height for Transfer component */
        .transfer-fill .ant-transfer {
          height: 400px !important;
          display: flex !important;
          flex-direction: column !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
        }
        .transfer-fill .ant-transfer-list {
          height: 400px !important;
          display: flex !important;
          flex-direction: column !important;
          border: 1px solid rgb(var(--color-border)) !important;
          border-radius: 6px !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
          box-sizing: border-box !important;
        }
        /* Ensure list header has fixed height */
        .transfer-fill .ant-transfer-list-header {
          flex-shrink: 0 !important;
          height: 40px !important;
          padding: 8px 12px !important;
          overflow-x: hidden !important;
        }
        /* Set fixed height and scroll for list body */
        .transfer-fill .ant-transfer-list-body {
          flex: 1 !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          min-height: 200px !important;
          max-height: 320px !important;
        }
        /* Ensure list footer has fixed height (if any) */
        .transfer-fill .ant-transfer-list-footer {
          flex-shrink: 0 !important;
          padding: 8px 12px !important;
          overflow-x: hidden !important;
        }
      }

      /* Normalize small typography paddings for tight, neat look */
      .ant-select .ant-select-selector {
        min-height: 36px;
        max-width: 100% !important;
      }
      .ant-tag {
        line-height: 20px;
      }

      /* Tablet responsive styles */
      @media (min-width: 641px) and (max-width: 1024px) {
        .ant-transfer {
          height: 350px !important;
          display: flex !important;
          flex-direction: column !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
        }
        .ant-transfer .ant-transfer-list {
          height: 350px !important;
          width: calc(50% - 12px) !important;
          max-width: 100% !important;
          overflow-x: hidden !important;
          box-sizing: border-box !important;
        }
        .transfer-fill .ant-transfer-list-body {
          max-height: 280px !important;
          overflow-x: hidden !important;
        }
      }

      /* General overflow prevention for all screen sizes */
      .ant-transfer-list-content {
        overflow-x: hidden !important;
      }

      .ant-transfer-list-content-item {
        overflow-x: hidden !important;
      }

      .ant-transfer-list-content-item-text {
        max-width: calc(100% - 40px) !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
    `,
            }}
          />
        </div>
      </div>

      {/* Bot edit drawer */}
      <TeamEditDrawer
        bots={bots}
        setBots={setBots}
        editingBotId={editingBotId}
        setEditingBotId={setEditingBotId}
        visible={editingBotDrawerVisible}
        setVisible={setEditingBotDrawerVisible}
        toast={toast}
        mode={drawerMode}
        editingTeam={editingTeam}
        onTeamUpdate={handleTeamUpdate}
        cloningBot={cloningBot}
        setCloningBot={setCloningBot}
        selectedBotKeys={selectedBotKeys}
        leaderBotId={leaderBotId}
        unsavedPrompts={unsavedPrompts}
        setUnsavedPrompts={setUnsavedPrompts}
      />
    </div>
  );
}
