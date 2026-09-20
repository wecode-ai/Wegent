// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import type { InstalledPlugin } from '@wegent/chat-core/installed-plugin-types'
import {
  AgentCapabilitiesSelector,
  AgentCapabilityModeSelector,
  AgentFormDialog,
  AgentPromptEditor,
  agentPluginBinding,
  buildInstalledPluginProjectCatalog,
  parseAgentMcpServers,
  resolveAgentPromptCapabilityReferences,
  type UnifiedAgentCapabilityMode,
  type UnifiedAgentRuntime,
} from '@wegent/collaboration'

import { apiClient } from '@/apis/client'
import { botApis } from '@/apis/bots'
import { modelApis, type UnifiedModel } from '@/apis/models'
import { fetchUnifiedSkillsList, type UnifiedSkill } from '@/apis/skills'
import { teamApis } from '@/apis/team'
import { useTranslation } from '@/hooks/useTranslation'
import { createPredefinedModelConfig } from '@/features/settings/services/bots'

function skillKey(skill: Pick<UnifiedSkill, 'name' | 'namespace'>): string {
  return `${skill.namespace || 'default'}:${skill.name}`
}

export function WebAgentResourceForm({
  namespace,
  onClose,
  onCreated,
  workspaceName,
}: {
  namespace: string
  onClose(): void
  onCreated(agent: { name: string; teamId: number }): Promise<void>
  workspaceName: string
}) {
  const { t } = useTranslation('common')
  const scope = namespace === 'default' ? 'personal' : 'group'
  const groupName = namespace === 'default' ? undefined : namespace
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [runtime, setRuntime] = useState<UnifiedAgentRuntime>('Codex')
  const [capabilityMode, setCapabilityMode] = useState<UnifiedAgentCapabilityMode>('follow_device')
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [selectedModelKey, setSelectedModelKey] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [mcpConfig, setMcpConfig] = useState('{}')
  const [skills, setSkills] = useState<UnifiedSkill[]>([])
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([])
  const [plugins, setPlugins] = useState(
    [] as ReturnType<typeof buildInstalledPluginProjectCatalog>
  )
  const [selectedPluginIds, setSelectedPluginIds] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [loadingSkills, setLoadingSkills] = useState(true)
  const [loadingPlugins, setLoadingPlugins] = useState(true)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [pluginError, setPluginError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoadingModels(true)
    void modelApis
      .getUnifiedModels(runtime, false, scope, groupName, 'llm')
      .then(response => {
        if (!active) return
        setModels(response.data.filter(model => model.isActive !== false))
        setSelectedModelKey('')
      })
      .catch(cause => {
        if (active) {
          setModels([])
          setError(cause instanceof Error ? cause.message : t('agent_form.model_load_failed'))
        }
      })
      .finally(() => {
        if (active) setLoadingModels(false)
      })

    return () => {
      active = false
    }
  }, [groupName, runtime, scope, t])

  useEffect(() => {
    let active = true
    void fetchUnifiedSkillsList({ limit: 100, scope, groupName })
      .then(items => {
        if (active) setSkills(items.filter(skill => skill.visible !== false))
      })
      .catch(cause => {
        if (active) {
          setSkillError(cause instanceof Error ? cause.message : t('agent_form.skills_load_failed'))
        }
      })
      .finally(() => {
        if (active) setLoadingSkills(false)
      })

    void apiClient
      .get<{ items: InstalledPlugin[] }>('/plugins/installed')
      .then(response => {
        if (!active) return
        setPlugins(
          buildInstalledPluginProjectCatalog(response.items).map(plugin => ({
            ...plugin,
            catalogSource: 'cloud',
          }))
        )
      })
      .catch(cause => {
        if (active) {
          setPluginError(
            cause instanceof Error ? cause.message : t('agent_form.plugins_load_failed')
          )
        }
      })
      .finally(() => {
        if (active) setLoadingPlugins(false)
      })

    return () => {
      active = false
    }
  }, [groupName, scope, t])

  const selectedSkills = useMemo(() => new Set(selectedSkillKeys), [selectedSkillKeys])
  const selectedPlugins = useMemo(() => new Set(selectedPluginIds), [selectedPluginIds])
  const promptCapabilities = useMemo(
    () => resolveAgentPromptCapabilityReferences(systemPrompt, plugins, skills),
    [plugins, skills, systemPrompt]
  )
  const effectiveSelectedPlugins = useMemo(
    () => new Set([...selectedPlugins, ...promptCapabilities.pluginIds]),
    [promptCapabilities.pluginIds, selectedPlugins]
  )
  const effectiveSelectedSkills = useMemo(
    () => new Set([...selectedSkills, ...promptCapabilities.skillKeys]),
    [promptCapabilities.skillKeys, selectedSkills]
  )
  const selectedModel = useMemo(
    () =>
      models.find(
        model => `${model.type}:${model.namespace || 'default'}:${model.name}` === selectedModelKey
      ) ?? null,
    [models, selectedModelKey]
  )

  const save = async () => {
    if (!name.trim()) {
      setError(t('agent_form.resource_name_required'))
      return
    }
    if (!selectedModel) {
      setError(t('agent_form.model_required'))
      return
    }

    let mcpServers: Record<string, unknown> = {}
    try {
      if (capabilityMode === 'manual') {
        mcpServers = parseAgentMcpServers(mcpConfig)
      }
    } catch {
      setError(t('agent_form.mcp_invalid'))
      return
    }

    setSaving(true)
    setError(null)
    try {
      const selectedSkillItems = skills.filter(skill =>
        effectiveSelectedSkills.has(skillKey(skill))
      )
      const savedBot = await botApis.createBot({
        name: `${name.trim()}-bot`,
        namespace,
        shell_name: runtime,
        capability_mode: capabilityMode,
        agent_config: {
          ...(createPredefinedModelConfig(
            selectedModel.name,
            selectedModel.type,
            selectedModel.namespace
          ) || {}),
        },
        system_prompt: systemPrompt.trim(),
        mcp_servers: mcpServers,
        plugins:
          capabilityMode === 'manual' && runtime === 'Codex'
            ? plugins
                .filter(plugin => effectiveSelectedPlugins.has(plugin.id))
                .map(agentPluginBinding)
            : [],
        skills: capabilityMode === 'manual' ? selectedSkillItems.map(skill => skill.name) : [],
        skill_refs: Object.fromEntries(
          (capabilityMode === 'manual' ? selectedSkillItems : []).map(skill => [
            skill.name,
            {
              skill_id: skill.id,
              namespace: skill.namespace || 'default',
              is_public: skill.is_public,
            },
          ])
        ),
        target_group_names: groupName ? [groupName] : [],
      })
      const savedTeam = await teamApis.createTeam({
        name: name.trim(),
        displayName: displayName.trim() || undefined,
        description: '',
        namespace,
        workflow: { mode: 'solo', leader_bot_id: savedBot.id },
        bind_mode: ['chat', 'code', 'task'],
        bots: [{ bot_id: savedBot.id, bot_prompt: '', role: 'leader' }],
        requires_workspace: true,
      })
      await onCreated({
        name: savedTeam.displayName || savedTeam.name,
        teamId: savedTeam.id,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('agent_form.create_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AgentFormDialog
      busy={saving}
      capabilities={
        capabilityMode === 'manual' ? (
          <AgentCapabilitiesSelector
            busy={saving}
            labels={{
              add: t('agent_form.add'),
              loadingPlugins: t('agent_form.plugins_loading'),
              loadingSkills: t('agent_form.skills_loading'),
              noneSelected: t('agent_form.none_selected'),
              noPlugins: t('agent_form.plugins_empty'),
              noSkills: t('agent_form.skills_empty'),
              plugins: t('agent_form.plugins'),
              pluginsUnavailable: t('agent_form.plugins_codex_only'),
              remove: t('agent_form.remove'),
              fromPrompt: t('agent_form.from_prompt'),
              sourceCloud: t('agent_form.source_cloud'),
              sourceLocal: t('agent_form.source_local'),
              sourceLocalCloud: t('agent_form.source_local_cloud'),
              searchPlugins: t('agent_form.search_plugins'),
              searchSkills: t('agent_form.search_skills'),
              skills: t('agent_form.skills'),
            }}
            loadingPlugins={loadingPlugins}
            loadingSkills={loadingSkills}
            onPluginChange={(pluginId, selected) =>
              setSelectedPluginIds(current =>
                selected ? [...current, pluginId] : current.filter(id => id !== pluginId)
              )
            }
            onSkillChange={(skill, selected) => {
              const key = skillKey(skill as UnifiedSkill)
              setSelectedSkillKeys(current =>
                selected ? [...current, key] : current.filter(item => item !== key)
              )
            }}
            pluginError={pluginError}
            plugins={plugins}
            pluginsEnabled={runtime === 'Codex'}
            selectedPluginIds={effectiveSelectedPlugins}
            selectedSkillKeys={effectiveSelectedSkills}
            requiredPluginIds={promptCapabilities.pluginIds}
            requiredSkillKeys={promptCapabilities.skillKeys}
            skillError={skillError}
            skillKey={skill => skillKey(skill as UnifiedSkill)}
            skills={skills}
            testIdPrefix="web-agent"
            collapsible={false}
            title={t('agent_form.configured_capabilities')}
          />
        ) : null
      }
      description={t('agent_form.description')}
      displayName={{
        label: t('agent_form.display_name'),
        onChange: setDisplayName,
        placeholder: t('agent_form.display_name_placeholder'),
        testId: 'web-agent-display-name',
        value: displayName,
      }}
      error={error}
      capabilityMode={
        <AgentCapabilityModeSelector
          busy={saving}
          currentDevice={null}
          labels={{
            devicePreviewHint: t('agent_form.device_preview_hint'),
            devicePreviewTitle: t('agent_form.device_preview_title'),
            devicePreviewUnavailable: t('agent_form.device_preview_unavailable'),
            followDescription: t('agent_form.follow_device_description'),
            followTitle: t('agent_form.follow_device_title'),
            loadingCapabilities: t('agent_form.loading_device_capabilities'),
            manualDescription: t('agent_form.manual_description'),
            manualReady: t('agent_form.manual_ready'),
            manualTitle: t('agent_form.manual_title'),
            title: t('agent_form.capability_source'),
          }}
          onChange={setCapabilityMode}
          testIdPrefix="web-agent"
          value={capabilityMode}
        />
      }
      footerHint={
        capabilityMode === 'follow_device'
          ? t('agent_form.follow_device_footer')
          : t('agent_form.manual_footer')
      }
      labels={{
        advanced: t('agent_form.advanced'),
        advancedDescription: t('agent_form.advanced_description'),
        capabilitiesSection: t('agent_form.capabilities_section'),
        cancel: t('actions.cancel'),
        close: t('actions.close'),
        owner: t('agent_form.owner'),
      }}
      mcp={
        capabilityMode === 'manual'
          ? {
              label: 'MCP',
              onChange: setMcpConfig,
              placeholder: '{"server":{"command":"node","args":["server.mjs"]}}',
              testId: 'web-agent-mcp',
              value: mcpConfig,
            }
          : undefined
      }
      model={{
        disabled: loadingModels,
        label: t('agent_form.model'),
        onChange: setSelectedModelKey,
        options: models.map(model => ({
          label: model.displayName || model.name,
          value: `${model.type}:${model.namespace || 'default'}:${model.name}`,
        })),
        placeholder: t('agent_form.model_placeholder'),
        testId: 'web-agent-model',
        value: selectedModelKey,
      }}
      name={{
        label: t('agent_form.resource_name'),
        onChange: setName,
        placeholder: t('agent_form.resource_name_placeholder'),
        testId: 'web-agent-resource-name',
        value: name,
      }}
      namespace={namespace}
      onClose={onClose}
      onSave={() => void save()}
      ownerLabel={workspaceName}
      prompt={{
        label: t('agent_form.prompt'),
        onChange: value => {
          setSystemPrompt(value)
          const references = resolveAgentPromptCapabilityReferences(value, plugins, skills)
          if (references.pluginIds.size || references.skillKeys.size) setCapabilityMode('manual')
        },
        placeholder: t('agent_form.prompt_placeholder'),
        testId: 'web-agent-system-prompt',
        value: systemPrompt,
      }}
      promptEditor={
        <AgentPromptEditor
          busy={saving}
          field={{
            label: t('agent_form.prompt'),
            onChange: value => {
              setSystemPrompt(value)
              const references = resolveAgentPromptCapabilityReferences(value, plugins, skills)
              if (references.pluginIds.size || references.skillKeys.size)
                setCapabilityMode('manual')
            },
            placeholder: t('agent_form.prompt_placeholder'),
            testId: 'web-agent-system-prompt',
            value: systemPrompt,
          }}
          plugins={plugins}
          skills={skills}
          translate={(key, fallback, options) =>
            String(t(key, { ...options, defaultValue: fallback ?? key }))
          }
        />
      }
      runtime={{
        label: t('agent_form.runtime'),
        onChange: value => setRuntime(value as UnifiedAgentRuntime),
        options: [
          { label: 'Codex', value: 'Codex' },
          { label: 'Claude Code', value: 'ClaudeCode' },
        ],
        testId: 'web-agent-runtime',
        value: runtime,
      }}
      saveDisabled={loadingModels || !selectedModel || !name.trim()}
      saveLabel={t('agent_form.title')}
      savingLabel={t('actions.creating')}
      testIds={{
        backdrop: 'web-agent-resource-creator-backdrop',
        close: 'web-agent-resource-creator-close',
        dialog: 'web-agent-resource-creator',
        error: 'web-agent-resource-creator-error',
        save: 'web-agent-resource-create',
      }}
      title={t('agent_form.title')}
    />
  )
}
