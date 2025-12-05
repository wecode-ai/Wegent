// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { GripVertical, Plus, Trash2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import {
  adminApis,
  QuickTeamItem,
  QuickTeamsConfig,
  AvailableTeam,
} from '@/apis/admin'
import IconPicker from './IconPicker'

interface QuickTeamsConfigComponentProps {}

export default function QuickTeamsConfigComponent({}: QuickTeamsConfigComponentProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [activeScene, setActiveScene] = useState<'chat' | 'code'>('chat')
  const [localConfig, setLocalConfig] = useState<QuickTeamsConfig>({ chat: [], code: [] })
  const [isDirty, setIsDirty] = useState(false)

  // Fetch current config
  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ['quickTeamsConfig'],
    queryFn: adminApis.getQuickTeamsConfig,
  })

  // Fetch available teams
  const { data: availableTeams, isLoading: teamsLoading } = useQuery({
    queryKey: ['availableTeamsForConfig'],
    queryFn: adminApis.getAvailableTeamsForConfig,
  })

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: adminApis.updateQuickTeamsConfig,
    onSuccess: () => {
      toast({ title: 'Configuration saved successfully' })
      queryClient.invalidateQueries({ queryKey: ['quickTeamsConfig'] })
      queryClient.invalidateQueries({ queryKey: ['quickTeams'] })
      setIsDirty(false)
    },
    onError: (error: Error) => {
      toast({ variant: 'destructive', title: 'Failed to save configuration', description: error.message })
    },
  })

  // Initialize local config from server config
  useEffect(() => {
    if (config) {
      setLocalConfig(config)
    }
  }, [config])

  // Get teams for current scene
  const currentSceneTeams = localConfig[activeScene] || []

  // Get team names map
  const teamNamesMap = useMemo(() => {
    const map: Record<number, AvailableTeam> = {}
    availableTeams?.items?.forEach((team) => {
      map[team.team_id] = team
    })
    return map
  }, [availableTeams])

  // Get available teams not in current config
  const unselectedTeams = useMemo(() => {
    const selectedIds = new Set(currentSceneTeams.map((t) => t.team_id))
    return (availableTeams?.items || []).filter((t) => !selectedIds.has(t.team_id))
  }, [availableTeams, currentSceneTeams])

  // Add team to current scene
  const handleAddTeam = (teamId: number) => {
    const newItem: QuickTeamItem = {
      team_id: teamId,
      icon: 'Users',
      sort_order: currentSceneTeams.length,
    }
    setLocalConfig((prev) => ({
      ...prev,
      [activeScene]: [...prev[activeScene], newItem],
    }))
    setIsDirty(true)
  }

  // Remove team from current scene
  const handleRemoveTeam = (teamId: number) => {
    setLocalConfig((prev) => ({
      ...prev,
      [activeScene]: prev[activeScene].filter((t) => t.team_id !== teamId),
    }))
    setIsDirty(true)
  }

  // Update team icon
  const handleIconChange = (teamId: number, icon: string) => {
    setLocalConfig((prev) => ({
      ...prev,
      [activeScene]: prev[activeScene].map((t) =>
        t.team_id === teamId ? { ...t, icon } : t
      ),
    }))
    setIsDirty(true)
  }

  // Move team up
  const handleMoveUp = (index: number) => {
    if (index === 0) return
    const newTeams = [...currentSceneTeams]
    const temp = newTeams[index - 1]
    newTeams[index - 1] = newTeams[index]
    newTeams[index] = temp
    // Update sort_order
    newTeams.forEach((t, i) => {
      t.sort_order = i
    })
    setLocalConfig((prev) => ({
      ...prev,
      [activeScene]: newTeams,
    }))
    setIsDirty(true)
  }

  // Move team down
  const handleMoveDown = (index: number) => {
    if (index === currentSceneTeams.length - 1) return
    const newTeams = [...currentSceneTeams]
    const temp = newTeams[index + 1]
    newTeams[index + 1] = newTeams[index]
    newTeams[index] = temp
    // Update sort_order
    newTeams.forEach((t, i) => {
      t.sort_order = i
    })
    setLocalConfig((prev) => ({
      ...prev,
      [activeScene]: newTeams,
    }))
    setIsDirty(true)
  }

  // Save config
  const handleSave = () => {
    updateMutation.mutate(localConfig)
  }

  if (configLoading || teamsLoading) {
    return <div className="p-4">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-2">Quick Teams Configuration</h2>
        <p className="text-sm text-text-muted">
          Configure which teams appear in the quick selection cards below the input area.
        </p>
      </div>

      {/* Scene Tabs */}
      <div className="flex gap-2 border-b border-border pb-2">
        <button
          onClick={() => setActiveScene('chat')}
          className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${
            activeScene === 'chat'
              ? 'bg-primary/10 text-primary border-b-2 border-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          Chat Scene
        </button>
        <button
          onClick={() => setActiveScene('code')}
          className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${
            activeScene === 'code'
              ? 'bg-primary/10 text-primary border-b-2 border-primary'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          Code Scene
        </button>
      </div>

      {/* Configured Teams */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Configured Teams</h3>
        {currentSceneTeams.length === 0 ? (
          <p className="text-sm text-text-muted py-4">
            No teams configured for this scene. Add teams from the list below.
          </p>
        ) : (
          <div className="space-y-2">
            {currentSceneTeams.map((item, index) => {
              const team = teamNamesMap[item.team_id]
              return (
                <div
                  key={item.team_id}
                  className="flex items-center gap-3 p-3 bg-surface border border-border rounded-lg"
                >
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => handleMoveUp(index)}
                      disabled={index === 0}
                      className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => handleMoveDown(index)}
                      disabled={index === currentSceneTeams.length - 1}
                      className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
                    >
                      ▼
                    </button>
                  </div>
                  <GripVertical className="w-4 h-4 text-text-muted" />
                  <IconPicker
                    value={item.icon}
                    onChange={(icon) => handleIconChange(item.team_id, icon)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {team?.team_name || `Team #${item.team_id}`}
                    </p>
                    {team?.description && (
                      <p className="text-xs text-text-muted truncate">{team.description}</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveTeam(item.team_id)}
                    className="h-8 w-8 text-error hover:text-error"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Available Teams */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Available Teams</h3>
        {unselectedTeams.length === 0 ? (
          <p className="text-sm text-text-muted py-4">All teams have been configured.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {unselectedTeams.map((team) => (
              <button
                key={team.team_id}
                onClick={() => handleAddTeam(team.team_id)}
                className="flex items-center gap-2 p-3 bg-surface border border-border rounded-lg hover:border-primary/50 hover:shadow-sm transition-all text-left"
              >
                <Plus className="w-4 h-4 text-primary flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{team.team_name}</p>
                  {team.description && (
                    <p className="text-xs text-text-muted truncate">{team.description}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Save Button */}
      <div className="flex justify-end gap-3 pt-4 border-t border-border">
        <Button
          variant="default"
          onClick={handleSave}
          disabled={!isDirty || updateMutation.isPending}
        >
          {updateMutation.isPending ? 'Saving...' : 'Save Configuration'}
          {!updateMutation.isPending && isDirty && <Check className="w-4 h-4 ml-2" />}
        </Button>
      </div>
    </div>
  )
}
