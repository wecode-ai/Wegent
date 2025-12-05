// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import Image from 'next/image';
import { Loader2 } from 'lucide-react';
import { RiRobot2Line } from 'react-icons/ri';

import { Bot, Team } from '@/types/api';
import { TeamMode, getFilteredBotsForMode, AgentType } from './team-modes';
import { createTeam, updateTeam } from '../services/teams';
import TeamEditDrawer from './TeamEditDrawer';
import { useTranslation } from '@/hooks/useTranslation';
import { shellApis, UnifiedShell } from '@/apis/shells';
import { BotEditRef } from './BotEdit';

// Import mode-specific editors
import SoloModeEditor from './team-modes/SoloModeEditor';
import PipelineModeEditor from './team-modes/PipelineModeEditor';
import LeaderModeEditor from './team-modes/LeaderModeEditor';

// Import CSS module for responsive styles
import styles from './TeamEdit.module.css';

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
  const [mode, setMode] = useState<TeamMode>('solo');

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
  // Mode change confirmation dialog state
  const [modeChangeDialogVisible, setModeChangeDialogVisible] = useState(false);
  const [pendingMode, setPendingMode] = useState<TeamMode | null>(null);

  // Shells data for resolving custom shell runtime types
  const [shells, setShells] = useState<UnifiedShell[]>([]);

  // Ref for BotEdit in solo mode
  const botEditRef = useRef<BotEditRef | null>(null);

  // Load shells data on mount
  useEffect(() => {
    const fetchShells = async () => {
      try {
        const response = await shellApis.getUnifiedShells();
        setShells(response.data || []);
      } catch (error) {
        console.error('Failed to fetch shells:', error);
      }
    };
    fetchShells();
  }, []);

  // Filter bots based on current mode, using shells to resolve custom shell runtime types
  const filteredBots = useMemo(() => {
    return getFilteredBotsForMode(bots, mode, shells);
  }, [bots, mode, shells]);

  // Get allowed agents for current mode
  const allowedAgentsForMode = useMemo((): AgentType[] | undefined => {
    const MODE_AGENT_FILTER: Record<TeamMode, AgentType[] | null> = {
      solo: null, // null means all agents are allowed
      pipeline: ['ClaudeCode', 'Agno'],
      route: ['Agno'],
      coordinate: ['Agno'],
      collaborate: ['Agno'],
    };
    const allowed = MODE_AGENT_FILTER[mode];
    return allowed === null ? undefined : allowed;
  }, [mode]);

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

    // Image mapping by mode (solo uses icon instead of image)
    const imageMap: Record<typeof mode, string | null> = {
      solo: null, // Use icon instead
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
  useEffect(() => {
    if (formTeam) {
      setName(formTeam.name);
      const m = (formTeam.workflow?.mode as TeamMode) || 'pipeline';
      setMode(m);
      const ids = formTeam.bots.map(b => String(b.bot_id));
      setSelectedBotKeys(ids);
      const leaderBot = formTeam.bots.find(b => b.role === 'leader');
      setLeaderBotId(leaderBot?.bot_id ?? null);
    } else {
      setName('');
      setMode('solo');
      setSelectedBotKeys([]);
      setLeaderBotId(null);
    }
  }, [editingTeamId, formTeam]);

  // When bots change, only update bots-related state, do not reset name and mode
  useEffect(() => {
    if (formTeam) {
      // Filter by both available bots and mode-compatible bots
      const ids = formTeam.bots
        .filter(b => filteredBots.some((bot: Bot) => bot.id === b.bot_id))
        .map(b => String(b.bot_id));
      setSelectedBotKeys(ids);
      const leaderBot = formTeam.bots.find(
        b => b.role === 'leader' && filteredBots.some((bot: Bot) => bot.id === b.bot_id)
      );
      setLeaderBotId(leaderBot?.bot_id ?? null);
    }
  }, [filteredBots, formTeam]);
  // Check if mode change needs confirmation (has team members or prompts)
  const needsModeChangeConfirmation = useCallback(() => {
    const hasSelectedBots = selectedBotKeys.length > 0 || leaderBotId !== null;
    const hasUnsavedPrompts = Object.values(unsavedPrompts).some(
      value => (value ?? '').trim().length > 0
    );
    const hasExistingPrompts =
      formTeam?.bots.some(bot => bot.bot_prompt && bot.bot_prompt.trim().length > 0) ?? false;

    return hasSelectedBots || hasUnsavedPrompts || hasExistingPrompts;
  }, [selectedBotKeys, leaderBotId, unsavedPrompts, formTeam]);

  // Execute mode change with reset
  const executeModeChange = useCallback((newMode: TeamMode) => {
    setMode(newMode);
    // Reset team roles and prompts
    setSelectedBotKeys([]);
    setLeaderBotId(null);
    setUnsavedPrompts({});
  }, []);

  // Change Mode with confirmation
  const handleModeChange = (newMode: TeamMode) => {
    // If same mode, do nothing
    if (newMode === mode) return;

    // Check if confirmation is needed
    if (needsModeChangeConfirmation()) {
      setPendingMode(newMode);
      setModeChangeDialogVisible(true);
    } else {
      executeModeChange(newMode);
    }
  };

  // Confirm mode change
  const handleConfirmModeChange = () => {
    if (pendingMode) {
      executeModeChange(pendingMode);
    }
    setModeChangeDialogVisible(false);
    setPendingMode(null);
  };

  // Cancel mode change
  const handleCancelModeChange = () => {
    setModeChangeDialogVisible(false);
    setPendingMode(null);
  };
  // Get currently selected shell_type (from leader or selected bot)
  // Note: shell_type restriction has been removed - users can now select any mode
  const selectedShellType = useMemo(() => {
    // No shell_type restriction - always return null
    return null;
  }, []);

  const isDifyLeader = useMemo(() => {
    if (leaderBotId === null) return false;
    const leader = filteredBots.find((b: Bot) => b.id === leaderBotId);
    return leader?.shell_type === 'Dify';
  }, [leaderBotId, filteredBots]);

  // Leader change handler
  const onLeaderChange = (botId: number) => {
    // If new leader is in selected bots, remove it from selected bots
    if (selectedBotKeys.some(k => Number(k) === botId)) {
      setSelectedBotKeys(prev => prev.filter(k => Number(k) !== botId));
    }

    const newLeader = filteredBots.find((b: Bot) => b.id === botId);
    // If the new leader is Dify, clear the selected bots
    if (newLeader?.shell_type === 'Dify') {
      setSelectedBotKeys([]);
    }

    setLeaderBotId(botId);
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
      const botToClone = filteredBots.find((b: Bot) => b.id === botId);
      if (!botToClone) {
        return;
      }
      setDrawerMode('edit');
      setCloningBot(botToClone);
      setEditingBotId(0);
      setEditingBotDrawerVisible(true);
    },
    [filteredBots]
  );
  // Save
  const handleSave = async () => {
    if (!name.trim()) {
      toast({
        variant: 'destructive',
        title: 'Team name is required',
      });
      return;
    }

    // For solo mode, we need to save the bot first via BotEdit ref
    if (mode === 'solo') {
      // Check if we have a bot edit ref to save
      if (botEditRef.current) {
        // Validate bot data first
        const validation = botEditRef.current.validateBot();
        if (!validation.isValid) {
          toast({
            variant: 'destructive',
            title: validation.error || t('bot.errors.required'),
          });
          return;
        }

        setSaving(true);
        try {
          // Save the bot and get its ID
          const savedBotId = await botEditRef.current.saveBot();
          if (savedBotId === null) {
            // Save failed, error toast already shown by BotEdit
            setSaving(false);
            return;
          }

          // Use the saved bot ID for the team
          const botsData = [
            {
              bot_id: savedBotId,
              bot_prompt: unsavedPrompts[`prompt-${savedBotId}`] || '',
              role: 'leader',
            },
          ];

          const workflow = { mode, leader_bot_id: savedBotId };

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
        return;
      }
    }

    // Non-solo mode or no bot edit ref - require leaderBotId
    if (leaderBotId == null) {
      toast({
        variant: 'destructive',
        title: mode === 'solo' ? 'Bot is required' : 'Leader bot is required',
      });
      return;
    }

    // For solo mode, only use leaderBotId
    const selectedIds = mode === 'solo' ? [] : selectedBotKeys.map(k => Number(k));

    // Note: shell_type consistency validation has been removed - users can now mix different agent types
    // Assemble bots data (per-step prompt not supported, all prompts empty)
    // Ensure leader bot is first, others follow transfer order
    const allBotIds: number[] = [];

    // Add leader bot first (if any)
    if (leaderBotId !== null) {
      allBotIds.push(leaderBotId);
    }

    // For solo mode, only include leaderBotId
    if (mode !== 'solo') {
      // Then add other bots, avoid duplicate leader bot (Skip if Dify leader)
      // When Dify is the leader, we do not save other team members
      if (!isDifyLeader) {
        selectedIds.forEach(id => {
          if (id !== leaderBotId) {
            allBotIds.push(id);
          }
        });
      }
    }

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
  // Leader dropdown options - show filtered bots based on mode
  const leaderOptions = useMemo(() => {
    return filteredBots;
  }, [filteredBots]);

  // Open prompt drawer handler
  const handleOpenPromptDrawer = useCallback(() => {
    setDrawerMode('prompt');
    setEditingBotDrawerVisible(true);
  }, []);

  const handleTeamUpdate = (updatedTeam: Team) => {
    setTeams(prev => prev.map(t => (t.id === updatedTeam.id ? updatedTeam : t)));
  };

  return (
    <div
      className={`flex flex-col flex-1 min-h-0 items-stretch bg-surface rounded-lg pt-0 pb-4 relative w-full max-w-none px-0 md:px-4 overflow-hidden ${styles.teamEditContainer}`}
    >
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
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center mb-1">
              <label className="block text-lg font-semibold text-text-primary">
                {t('team.model')} <span className="text-red-400">*</span>
              </label>
            </div>

            {/* Integrate Mode selection and description into one container */}
            <div className="relative rounded-md border border-border bg-base p-4 flex flex-col flex-1 min-h-0">
              {/* Mode selection */}
              <div className="mb-3">
                <RadioGroup
                  value={mode}
                  onValueChange={value => handleModeChange(value as TeamMode)}
                  className="w-full grid grid-cols-5 gap-2"
                >
                  {['solo', 'pipeline', 'route', 'coordinate', 'collaborate'].map(opt => (
                    <div key={opt} className="flex items-center">
                      <RadioGroupItem value={opt} id={`mode-${opt}`} className="peer sr-only" />
                      <label
                        htmlFor={`mode-${opt}`}
                        className={`
                          flex items-center justify-center w-full px-3 py-1.5 text-sm font-medium
                          rounded-md cursor-pointer transition-colors
                          border border-border
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
                  {MODE_INFO.info.image ? (
                    <Image
                      src={MODE_INFO.info.image}
                      alt={MODE_INFO.info.title}
                      width={640}
                      height={360}
                      className="object-contain w-full h-full max-h-full"
                    />
                  ) : (
                    <div className="flex items-center justify-center w-full h-full bg-muted/30 rounded-lg">
                      <RiRobot2Line className="w-24 h-24 text-primary/60" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right column - Mode-specific editor */}
        <div className="w-full lg:w-3/5 xl:w-2/3 min-w-0 flex flex-col min-h-0 flex-1">
          {mode === 'solo' && (
            <SoloModeEditor
              bots={filteredBots}
              setBots={setBots}
              selectedBotId={leaderBotId}
              setSelectedBotId={setLeaderBotId}
              editingTeam={editingTeam}
              toast={toast}
              unsavedPrompts={unsavedPrompts}
              teamPromptMap={teamPromptMap}
              onOpenPromptDrawer={handleOpenPromptDrawer}
              onCreateBot={handleCreateBot}
              allowedAgents={allowedAgentsForMode}
              editingTeamId={editingTeamId}
              botEditRef={botEditRef}
            />
          )}

          {/* Pipeline mode: Show PipelineModeEditor */}
          {mode === 'pipeline' && (
            <PipelineModeEditor
              bots={filteredBots}
              selectedBotKeys={selectedBotKeys}
              setSelectedBotKeys={setSelectedBotKeys}
              leaderBotId={leaderBotId}
              setLeaderBotId={setLeaderBotId}
              unsavedPrompts={unsavedPrompts}
              teamPromptMap={teamPromptMap}
              isDifyLeader={isDifyLeader}
              toast={toast}
              onEditBot={handleEditBot}
              onCreateBot={handleCreateBot}
              onCloneBot={handleCloneBot}
              onOpenPromptDrawer={handleOpenPromptDrawer}
            />
          )}

          {/* Leader modes (route, coordinate, collaborate): Show LeaderModeEditor */}
          {(mode === 'route' || mode === 'coordinate' || mode === 'collaborate') && (
            <LeaderModeEditor
              bots={filteredBots}
              selectedBotKeys={selectedBotKeys}
              setSelectedBotKeys={setSelectedBotKeys}
              leaderBotId={leaderBotId}
              setLeaderBotId={setLeaderBotId}
              unsavedPrompts={unsavedPrompts}
              teamPromptMap={teamPromptMap}
              isDifyLeader={isDifyLeader}
              selectedShellType={selectedShellType}
              leaderOptions={leaderOptions}
              toast={toast}
              onEditBot={handleEditBot}
              onCreateBot={handleCreateBot}
              onCloneBot={handleCloneBot}
              onOpenPromptDrawer={handleOpenPromptDrawer}
              onLeaderChange={onLeaderChange}
            />
          )}
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
        allowedAgents={allowedAgentsForMode}
      />

      {/* Mode change confirmation dialog */}
      <Dialog open={modeChangeDialogVisible} onOpenChange={setModeChangeDialogVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('team.mode_change_confirm_title')}</DialogTitle>
            <DialogDescription>{t('team.mode_change_confirm_message')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancelModeChange}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleConfirmModeChange}>{t('common.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
