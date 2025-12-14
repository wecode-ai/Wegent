// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';

import { Bot, Team } from '@/types/api';
import { TeamMode, getFilteredBotsForMode, AgentType } from './team-modes';
import { createTeam, updateTeam } from '../services/teams';
import TeamEditDrawer from './TeamEditDrawer';
import { useTranslation } from '@/hooks/useTranslation';
import { shellApis, UnifiedShell } from '@/apis/shells';
import { BotEditRef } from './BotEdit';

// Import sub-components
import TeamBasicInfoForm from './team-edit/TeamBasicInfoForm';
import TeamModeSelector from './team-edit/TeamModeSelector';
import TeamModeEditor from './team-edit/TeamModeEditor';
import TeamModeChangeDialog from './team-edit/TeamModeChangeDialog';

interface TeamEditDialogProps {
  open: boolean;
  onClose: () => void;
  teams: Team[];
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>;
  editingTeamId: number | null;
  initialTeam?: Team | null;
  bots: Bot[];
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>;
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast'];
  scope?: 'personal' | 'group' | 'all';
  groupName?: string;
}

export default function TeamEditDialog(props: TeamEditDialogProps) {
  const {
    open,
    onClose,
    teams,
    setTeams,
    editingTeamId,
    initialTeam = null,
    bots,
    setBots,
    toast,
    scope = 'personal',
    groupName,
  } = props;

  const { t } = useTranslation('common');

  // Current editing object (0 means create new)
  const editingTeam: Team | null =
    editingTeamId === 0 ? null : teams.find(t => t.id === editingTeamId) || null;

  const formTeam = editingTeam ?? (editingTeamId === 0 ? initialTeam : null) ?? null;

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<TeamMode>('solo');
  const [bindMode, setBindMode] = useState<('chat' | 'code')[]>(['chat', 'code']);
  const [icon, setIcon] = useState<string | null>(null);

  // Bot selection state
  const [selectedBotKeys, setSelectedBotKeys] = useState<React.Key[]>([]);
  const [leaderBotId, setLeaderBotId] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);

  // Bot editing related state
  const [editingBotDrawerVisible, setEditingBotDrawerVisible] = useState(false);
  const [editingBotId, setEditingBotId] = useState<number | null>(null);
  const [drawerMode, setDrawerMode] = useState<'edit' | 'prompt'>('edit');
  const [cloningBot, setCloningBot] = useState<Bot | null>(null);

  // Store unsaved team prompts
  const [unsavedPrompts, setUnsavedPrompts] = useState<Record<string, string>>({});

  // Mode change confirmation dialog state
  const [modeChangeDialogVisible, setModeChangeDialogVisible] = useState(false);
  const [pendingMode, setPendingMode] = useState<TeamMode | null>(null);

  // State to trigger collapse of TeamModeSelector after confirmation
  const [shouldCollapseSelector, setShouldCollapseSelector] = useState(false);

  // Shells data for resolving custom shell runtime types
  const [shells, setShells] = useState<UnifiedShell[]>([]);

  // Ref for BotEdit in solo mode
  const botEditRef = useRef<BotEditRef | null>(null);

  // Load shells data on mount
  useEffect(() => {
    if (!open) return;
    const fetchShells = async () => {
      try {
        const response = await shellApis.getUnifiedShells(scope, groupName);
        setShells(response.data || []);
      } catch (error) {
        console.error('Failed to fetch shells:', error);
      }
    };
    fetchShells();
  }, [open, scope, groupName]);

  // Filter bots based on current mode
  const filteredBots = useMemo(() => {
    return getFilteredBotsForMode(bots, mode, shells);
  }, [bots, mode, shells]);

  // Get allowed agents for current mode
  const allowedAgentsForMode = useMemo((): AgentType[] | undefined => {
    const MODE_AGENT_FILTER: Record<TeamMode, AgentType[] | null> = {
      solo: null,
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

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return;

    if (formTeam) {
      setName(formTeam.name);
      setDescription(formTeam.description || '');
      setIcon(formTeam.icon || null);
      const m = (formTeam.workflow?.mode as TeamMode) || 'pipeline';
      setMode(m);
      if (formTeam.bind_mode && Array.isArray(formTeam.bind_mode)) {
        setBindMode(formTeam.bind_mode);
      } else {
        const recMode =
          formTeam.recommended_mode ||
          (formTeam.workflow?.recommended_mode as 'chat' | 'code' | 'both' | undefined);
        if (recMode === 'chat') {
          setBindMode(['chat']);
        } else if (recMode === 'code') {
          setBindMode(['code']);
        } else {
          setBindMode(['chat', 'code']);
        }
      }
      const ids = formTeam.bots.map(b => String(b.bot_id));
      setSelectedBotKeys(ids);
      const leaderBot = formTeam.bots.find(b => b.role === 'leader');
      setLeaderBotId(leaderBot?.bot_id ?? null);
    } else {
      setName('');
      setDescription('');
      setIcon(null);
      setMode('solo');
      setBindMode(['chat', 'code']);
      setSelectedBotKeys([]);
      setLeaderBotId(null);
    }
    setUnsavedPrompts({});
  }, [open, formTeam]);

  // Update bot selection when bots change
  useEffect(() => {
    if (!open || !formTeam) return;

    const ids = formTeam.bots
      .filter(b => filteredBots.some((bot: Bot) => bot.id === b.bot_id))
      .map(b => String(b.bot_id));
    setSelectedBotKeys(ids);
    const leaderBot = formTeam.bots.find(
      b => b.role === 'leader' && filteredBots.some((bot: Bot) => bot.id === b.bot_id)
    );
    setLeaderBotId(leaderBot?.bot_id ?? null);
  }, [open, filteredBots, formTeam]);

  // Check if mode change needs confirmation
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
    setSelectedBotKeys([]);
    setLeaderBotId(null);
    setUnsavedPrompts({});
  }, []);

  // Change Mode with confirmation
  const handleModeChange = (newMode: TeamMode) => {
    if (newMode === mode) return;

    if (needsModeChangeConfirmation()) {
      setPendingMode(newMode);
      setModeChangeDialogVisible(true);
    } else {
      executeModeChange(newMode);
      setShouldCollapseSelector(true);
    }
  };

  const handleConfirmModeChange = () => {
    if (pendingMode) {
      executeModeChange(pendingMode);
    }
    setModeChangeDialogVisible(false);
    setPendingMode(null);
    setShouldCollapseSelector(true);
  };

  const handleCollapseHandled = useCallback(() => {
    setShouldCollapseSelector(false);
  }, []);

  const handleCancelModeChange = () => {
    setModeChangeDialogVisible(false);
    setPendingMode(null);
  };

  const isDifyLeader = useMemo(() => {
    if (leaderBotId === null) return false;
    const leader = filteredBots.find((b: Bot) => b.id === leaderBotId);
    return leader?.shell_type === 'Dify';
  }, [leaderBotId, filteredBots]);

  // Leader change handler
  const onLeaderChange = (botId: number) => {
    if (selectedBotKeys.some(k => Number(k) === botId)) {
      setSelectedBotKeys(prev => prev.filter(k => Number(k) !== botId));
    }

    const newLeader = filteredBots.find((b: Bot) => b.id === botId);
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
      if (!botToClone) return;
      setDrawerMode('edit');
      setCloningBot(botToClone);
      setEditingBotId(0);
      setEditingBotDrawerVisible(true);
    },
    [filteredBots]
  );

  const handleOpenPromptDrawer = useCallback(() => {
    setDrawerMode('prompt');
    setEditingBotDrawerVisible(true);
  }, []);

  const handleTeamUpdate = (updatedTeam: Team) => {
    setTeams(prev => prev.map(t => (t.id === updatedTeam.id ? updatedTeam : t)));
  };

  // Save handler
  const handleSave = async () => {
    if (!name.trim()) {
      toast({
        variant: 'destructive',
        title: t('team.name_required'),
      });
      return;
    }

    // For solo mode, save bot first via BotEdit ref
    if (mode === 'solo') {
      if (botEditRef.current) {
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
          const savedBotId = await botEditRef.current.saveBot();
          if (savedBotId === null) {
            setSaving(false);
            return;
          }

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
              description: description.trim() || undefined,
              workflow,
              bind_mode: bindMode,
              bots: botsData,
              namespace: scope === 'group' && groupName ? groupName : undefined,
              icon: icon || undefined,
            });
            setTeams(prev => prev.map(team => (team.id === updated.id ? updated : team)));
          } else {
            const created = await createTeam({
              name: name.trim(),
              description: description.trim() || undefined,
              workflow,
              bind_mode: bindMode,
              bots: botsData,
              namespace: scope === 'group' && groupName ? groupName : undefined,
              icon: icon || undefined,
            });
            setTeams(prev => [created, ...prev]);
          }

          setUnsavedPrompts({});
          onClose();
        } catch (error) {
          toast({
            variant: 'destructive',
            title:
              (error as Error)?.message ||
              (editingTeam ? t('teams.edit_failed') : t('teams.create_failed')),
          });
        } finally {
          setSaving(false);
        }
        return;
      }
    }

    // Non-solo mode - require leaderBotId
    if (leaderBotId == null) {
      toast({
        variant: 'destructive',
        title: mode === 'solo' ? t('team.bot_required') : t('team.leader_required'),
      });
      return;
    }

    const selectedIds = mode === 'solo' ? [] : selectedBotKeys.map(k => Number(k));
    const allBotIds: number[] = [];

    if (leaderBotId !== null) {
      allBotIds.push(leaderBotId);
    }

    if (mode !== 'solo' && !isDifyLeader) {
      selectedIds.forEach(id => {
        if (id !== leaderBotId) {
          allBotIds.push(id);
        }
      });
    }

    const botsData = allBotIds.map(id => {
      const existingBot = formTeam?.bots.find(b => b.bot_id === id);
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
          description: description.trim() || undefined,
          workflow,
          bind_mode: bindMode,
          bots: botsData,
          namespace: scope === 'group' && groupName ? groupName : undefined,
          icon: icon || undefined,
        });
        setTeams(prev => prev.map(team => (team.id === updated.id ? updated : team)));
      } else {
        const created = await createTeam({
          name: name.trim(),
          description: description.trim() || undefined,
          workflow,
          bind_mode: bindMode,
          bots: botsData,
          namespace: scope === 'group' && groupName ? groupName : undefined,
          icon: icon || undefined,
        });
        setTeams(prev => [created, ...prev]);
      }
      setUnsavedPrompts({});
      onClose();
    } catch (error) {
      toast({
        variant: 'destructive',
        title:
          (error as Error)?.message ||
          (editingTeam ? t('teams.edit_failed') : t('teams.create_failed')),
      });
    } finally {
      setSaving(false);
    }
  };

  const leaderOptions = useMemo(() => filteredBots, [filteredBots]);

  const isEditing = editingTeamId !== null && editingTeamId > 0;

  return (
    <>
      <Dialog open={open} onOpenChange={open => !open && onClose()}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{isEditing ? t('teams.edit_title') : t('teams.create_title')}</DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-6 py-4">
            {/* Basic Info Section */}
            <TeamBasicInfoForm
              name={name}
              setName={setName}
              description={description}
              setDescription={setDescription}
              bindMode={bindMode}
              setBindMode={setBindMode}
              icon={icon}
              setIcon={setIcon}
            />

            {/* Mode Selection Section */}
            <TeamModeSelector
              mode={mode}
              onModeChange={handleModeChange}
              shouldCollapse={shouldCollapseSelector}
              onCollapseHandled={handleCollapseHandled}
            />

            {/* Mode-specific Editor Section */}
            <TeamModeEditor
              mode={mode}
              filteredBots={filteredBots}
              setBots={setBots}
              selectedBotKeys={selectedBotKeys}
              setSelectedBotKeys={setSelectedBotKeys}
              leaderBotId={leaderBotId}
              setLeaderBotId={setLeaderBotId}
              editingTeam={editingTeam}
              editingTeamId={editingTeamId}
              toast={toast}
              unsavedPrompts={unsavedPrompts}
              teamPromptMap={teamPromptMap}
              isDifyLeader={isDifyLeader}
              leaderOptions={leaderOptions}
              allowedAgentsForMode={allowedAgentsForMode}
              botEditRef={botEditRef}
              scope={scope}
              groupName={groupName}
              onEditBot={handleEditBot}
              onCreateBot={handleCreateBot}
              onCloneBot={handleCloneBot}
              onOpenPromptDrawer={handleOpenPromptDrawer}
              onLeaderChange={onLeaderChange}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving} variant="primary">
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saving ? t('actions.saving') : t('actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        scope={scope}
        groupName={groupName}
      />

      {/* Mode change confirmation dialog */}
      <TeamModeChangeDialog
        open={modeChangeDialogVisible}
        onOpenChange={setModeChangeDialogVisible}
        onConfirm={handleConfirmModeChange}
        onCancel={handleCancelModeChange}
      />
    </>
  );
}
