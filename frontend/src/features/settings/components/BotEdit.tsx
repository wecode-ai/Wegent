// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React, {
  useCallback,
  useState,
  useEffect,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, XIcon, SettingsIcon, Edit, Wand2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import McpConfigSection from './McpConfigSection'
import SkillManagementModal from './skills/SkillManagementModal'
import { RichSkillSelector } from './skills/RichSkillSelector'
import DifyBotConfig from './DifyBotConfig'
import PromptFineTuneDialog from '@/features/prompt-tune/components/PromptFineTuneDialog'
import { KnowledgeBaseMultiSelector } from './knowledge/KnowledgeBaseMultiSelector'

import { Bot } from '@/types/api'
import {
  botApis,
  CreateBotRequest,
  KnowledgeBaseDefaultRef,
  SkillRefMeta,
  UpdateBotRequest,
} from '@/apis/bots'
import {
  isPredefinedModel,
  getModelFromConfig,
  getModelTypeFromConfig,
  getModelNamespaceFromConfig,
  createPredefinedModelConfig,
  getAllowedModelsFromConfig,
  AllowedModelRef,
} from '@/features/settings/services/bots'
import { modelApis, UnifiedModel, ModelTypeEnum } from '@/apis/models'
import { shellApis, UnifiedShell } from '@/apis/shells'
import { fetchUnifiedSkillsList, fetchPublicSkillsList, UnifiedSkill } from '@/apis/skills'
import { publicResourceApis, PublicBotFormData } from '@/apis/publicResources'
import { useTranslation } from '@/hooks/useTranslation'
import { adaptMcpConfigForAgent, isValidAgentType } from '../utils/mcpTypeAdapter'
import { buildSkillRefsFromSelection } from '../utils/skillRefResolver'
import { filterVisibleSkills } from '@/utils/skillVisibility'

/** Agent types supported by the system */
export type AgentType = 'ClaudeCode' | 'Agno' | 'Dify'

/** Interface for bot data returned by getBotData */
export interface BotFormData {
  name: string
  shell_name: string
  agent_config: Record<string, unknown>
  system_prompt: string
  mcp_servers: Record<string, unknown>
  default_knowledge_base_refs: KnowledgeBaseDefaultRef[]
  skills: string[]
  skill_refs: Record<string, SkillRefMeta>
  preload_skills: string[]
  preload_skill_refs: Record<string, SkillRefMeta>
}

/** Interface for validation result */
export interface BotValidationResult {
  isValid: boolean
  error?: string
}

/** Ref interface exposed by BotEdit */
export interface BotEditRef {
  /** Get current bot form data */
  getBotData: () => BotFormData | null
  /** Validate bot form data */
  validateBot: () => BotValidationResult
  /** Save bot (create or update) and return the bot id */
  saveBot: () => Promise<number | null>
}

interface BotEditProps {
  bots: Bot[]
  setBots: React.Dispatch<React.SetStateAction<Bot[]>>
  editingBotId: number
  cloningBot: Bot | null
  onClose: () => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  /** Whether the component is embedded in another component (hides back button) */
  embedded?: boolean
  /** Whether the component is in read-only mode */
  readOnly?: boolean
  /** Callback when user clicks edit button in read-only mode */
  onEditClick?: () => void
  /** Callback when user clicks cancel button in edit mode (only for embedded mode) */
  onCancelEdit?: () => void
  /** List of allowed agent types for filtering. If not provided, all agents are shown */
  allowedAgents?: AgentType[]
  /** Whether to hide action buttons (save/edit/cancel) - useful when parent handles saving */
  hideActions?: boolean
  /** Scope for filtering shells */
  scope?: 'personal' | 'group' | 'all' | 'public'
  /** Group name when scope is 'group' */
  groupName?: string
}
const BotEditInner: React.ForwardRefRenderFunction<BotEditRef, BotEditProps> = (
  {
    bots,
    setBots,
    editingBotId,
    cloningBot,
    onClose,
    toast,
    embedded = false,
    readOnly = false,
    onEditClick,
    onCancelEdit,
    allowedAgents,
    hideActions = false,
    scope,
    groupName,
  },
  ref
) => {
  const { t, i18n } = useTranslation()

  const [botSaving, setBotSaving] = useState(false)
  const [shells, setShells] = useState<UnifiedShell[]>([])
  const [loadingShells, setLoadingShells] = useState(false)
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [isCustomModel, setIsCustomModel] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedModelType, setSelectedModelType] = useState<ModelTypeEnum | undefined>(undefined)
  const [selectedModelNamespace, setSelectedModelNamespace] = useState<string | undefined>(
    undefined
  )
  const [selectedProtocol, setSelectedProtocol] = useState('')
  // Whether to restrict available models (allowed_models whitelist)
  const [restrictModels, setRestrictModels] = useState(false)
  const [allowedModels, setAllowedModels] = useState<AllowedModelRef[]>([])

  // Current editing object
  const editingBot = editingBotId > 0 ? bots.find(b => b.id === editingBotId) || null : null

  const baseBot = useMemo(() => {
    if (editingBot) {
      return editingBot
    }
    if (editingBotId === 0 && cloningBot) {
      return cloningBot
    }
    return null
  }, [editingBot, editingBotId, cloningBot])

  const [botName, setBotName] = useState(baseBot?.name || '')
  // Use shell_name for the selected shell, fallback to shell_type for backward compatibility
  const [agentName, setAgentName] = useState(baseBot?.shell_name || baseBot?.shell_type || '')
  // Helper function to remove protocol from agent_config for display
  const getAgentConfigWithoutProtocol = (config: Record<string, unknown> | undefined): string => {
    if (!config) return ''

    const { protocol: _, ...rest } = config
    return Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : ''
  }
  const [agentConfig, setAgentConfig] = useState(
    baseBot?.agent_config ? getAgentConfigWithoutProtocol(baseBot.agent_config) : ''
  )

  const [prompt, setPrompt] = useState(baseBot?.system_prompt || '')
  const [mcpConfig, setMcpConfig] = useState(
    baseBot?.mcp_servers ? JSON.stringify(baseBot.mcp_servers, null, 2) : ''
  )
  const [defaultKnowledgeBaseRefs, setDefaultKnowledgeBaseRefs] = useState<
    KnowledgeBaseDefaultRef[]
  >(baseBot?.default_knowledge_base_refs || [])
  const [selectedSkills, setSelectedSkills] = useState<string[]>(baseBot?.skills || [])
  const [preloadSkills, setPreloadSkills] = useState<string[]>(baseBot?.preload_skills || [])
  const [selectedSkillRefs, setSelectedSkillRefs] = useState<Record<string, SkillRefMeta>>(
    baseBot?.skill_refs || {}
  )
  const [allSkills, setAllSkills] = useState<UnifiedSkill[]>([])
  const [availableSkills, setAvailableSkills] = useState<UnifiedSkill[]>([])
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [_agentConfigError, setAgentConfigError] = useState(false)

  const [skillManagementModalOpen, setSkillManagementModalOpen] = useState(false)
  const [promptFineTuneOpen, setPromptFineTuneOpen] = useState(false)

  // Check if current agent is Dify
  const isDifyAgent = useMemo(() => agentName === 'Dify', [agentName])
  const mcpAgentType = useMemo(
    () => (isValidAgentType(agentName) ? agentName : undefined),
    [agentName]
  )

  // Documentation handlers
  const handleOpenModelDocs = useCallback(() => {
    const lang = i18n.language === 'zh-CN' ? 'zh' : 'en'
    const docsUrl = `https://github.com/wecode-ai/wegent/blob/main/docs/${lang}/user-guide/configuring-models.md`
    window.open(docsUrl, '_blank')
  }, [i18n.language])

  const handleOpenShellDocs = useCallback(() => {
    const lang = i18n.language === 'zh-CN' ? 'zh' : 'en'
    const docsUrl = `https://github.com/wecode-ai/wegent/blob/main/docs/${lang}/user-guide/configuring-shells.md`
    window.open(docsUrl, '_blank')
  }, [i18n.language])

  // Get shells list (including both public and user-defined shells)
  useEffect(() => {
    // Wait for scope to be defined before fetching
    if (scope === undefined) {
      return
    }

    const fetchShells = async () => {
      setLoadingShells(true)
      try {
        let shellData: UnifiedShell[] = []

        if (scope === 'public') {
          // For public scope, use public resource API
          shellData = await publicResourceApis.getPublicShells()
        } else {
          // For other scopes, use regular shell API
          const response = await shellApis.getUnifiedShells(scope, groupName)
          shellData = response.data || []
        }

        // Filter shells based on allowedAgents prop (using shellType as agent type)
        let filteredShells = shellData
        if (allowedAgents && allowedAgents.length > 0) {
          filteredShells = filteredShells.filter(shell =>
            allowedAgents.includes(shell.shellType as AgentType)
          )
        }
        setShells(filteredShells)
      } catch (error) {
        console.error('Failed to fetch shells:', error)
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.fetch_agents_failed'),
        })
      } finally {
        setLoadingShells(false)
      }
    }

    fetchShells()
  }, [toast, t, allowedAgents, scope, groupName])

  // Check if current agent supports skills (ClaudeCode and Chat shell types)
  const supportsSkills = useMemo(() => {
    // Get shell type from the selected shell
    const selectedShell = shells.find(s => s.name === agentName)
    const shellType = selectedShell?.shellType || agentName
    // Skills are supported for ClaudeCode and Chat shell types
    return shellType === 'ClaudeCode' || shellType === 'Chat'
  }, [agentName, shells])

  // Check if current agent supports preload skills (Chat only)
  const supportsPreloadSkills = useMemo(() => {
    const selectedShell = shells.find(s => s.name === agentName)
    const shellType = selectedShell?.shellType || agentName
    // Preload skills are only supported for Chat shell type
    return shellType === 'Chat'
  }, [agentName, shells])

  // Filter skills based on current shell type
  // Note: bindShells filtering is deprecated, skills can be used in any context
  const filterSkillsByShellType = useCallback((skills: UnifiedSkill[]): UnifiedSkill[] => {
    return skills
  }, [])

  const filterSelectableSkills = useCallback(
    (skills: UnifiedSkill[]): UnifiedSkill[] => {
      return scope === 'public' ? skills : filterVisibleSkills(skills)
    },
    [scope]
  )

  useEffect(() => {
    // Only fetch skills when agent supports skills (ClaudeCode or Chat)
    if (!supportsSkills) {
      setAllSkills([])
      setAvailableSkills([])
      setLoadingSkills(false)
      return
    }

    const fetchSkills = async () => {
      setLoadingSkills(true)
      try {
        // For public scope, use fetchPublicSkillsList; otherwise use fetchUnifiedSkillsList
        const skillsData =
          scope === 'public'
            ? await fetchPublicSkillsList()
            : await fetchUnifiedSkillsList({
                scope: scope,
                groupName: groupName,
              })
        setAllSkills(skillsData)
        // Filter skills based on current shell type
        setAvailableSkills(filterSkillsByShellType(filterSelectableSkills(skillsData)))
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:skills.loading_failed'),
        })
      } finally {
        setLoadingSkills(false)
      }
    }
    fetchSkills()
  }, [supportsSkills, toast, t, filterSkillsByShellType, filterSelectableSkills, scope, groupName])

  // Re-filter available skills when shell type changes
  useEffect(() => {
    if (allSkills.length > 0) {
      setAvailableSkills(filterSkillsByShellType(filterSelectableSkills(allSkills)))
    }
  }, [allSkills, filterSkillsByShellType, filterSelectableSkills])

  // Fetch corresponding model list when agentName changes
  useEffect(() => {
    if (!agentName) {
      setModels([])
      return
    }

    const fetchModels = async () => {
      setLoadingModels(true)
      try {
        // Find the selected shell to get its shellType for model filtering
        const selectedShell = shells.find(s => s.name === agentName)
        // Use shell's shellType for model filtering, fallback to agentName for public shells
        const shellType = selectedShell?.shellType || agentName

        let modelData: UnifiedModel[] = []

        if (scope === 'public') {
          // For public scope, use public resource API
          modelData = await publicResourceApis.getPublicModels(shellType, 'llm')
        } else {
          // Use the new unified models API which includes type information
          // Pass scope and groupName to filter models based on current context
          // Filter by 'llm' category type - only LLM models can be used for bots
          const response = await modelApis.getUnifiedModels(
            shellType,
            false,
            scope,
            groupName,
            'llm'
          )
          modelData = response.data
        }

        setModels(modelData)

        // After loading models, check if we should restore the bot's saved model
        // This handles the case when editing an existing bot with a predefined model
        // Only restore if the current agentName matches the baseBot's shell_name
        // (i.e., user hasn't switched to a different agent)
        const hasConfig = baseBot?.agent_config && Object.keys(baseBot.agent_config).length > 0
        // Use shell_name for comparison, fallback to shell_type for backward compatibility
        const baseBotShellName = baseBot?.shell_name || baseBot?.shell_type
        const agentMatches = baseBotShellName === agentName
        const isPredefined = hasConfig && isPredefinedModel(baseBot.agent_config)

        if (hasConfig && agentMatches && isPredefined) {
          const savedModelName = getModelFromConfig(baseBot.agent_config)
          const savedModelType = getModelTypeFromConfig(baseBot.agent_config)
          // Only set the model if it exists in the loaded models list
          // Match by both name and type if type is specified
          const foundModel = modelData.find((m: UnifiedModel) => {
            if (savedModelType) {
              return m.name === savedModelName && m.type === savedModelType
            }
            return m.name === savedModelName
          })
          if (savedModelName && foundModel) {
            setSelectedModel(savedModelName)
            setSelectedModelType(foundModel.type)
          } else {
            // Model not found in list, clear selection
            setSelectedModel('')
            setSelectedModelType(undefined)
          }
        }
        // Note: Don't clear selectedModel here if agent changed,
        // as it's already cleared in the agent select onChange handler
      } catch (error) {
        console.error('Failed to fetch models:', error)
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.fetch_models_failed'),
        })
        setModels([])
        setSelectedModel('')
        setSelectedModelType(undefined)
      } finally {
        setLoadingModels(false)
      }
    }

    fetchModels()
  }, [agentName, shells, toast, t, baseBot, scope, groupName])

  // Reset base form when switching editing object
  useEffect(() => {
    setBotName(baseBot?.name || '')
    // Use shell_name for the selected shell, fallback to shell_type for backward compatibility
    setAgentName(baseBot?.shell_name || baseBot?.shell_type || '')
    setPrompt(baseBot?.system_prompt || '')

    // Apply type normalization when loading MCP config
    if (baseBot?.mcp_servers) {
      const shellName = baseBot.shell_name || baseBot.shell_type || ''
      const shell = shells.find(s => s.name === shellName)
      const agentType = shell?.shellType

      if (agentType && isValidAgentType(agentType)) {
        const adaptedConfig = adaptMcpConfigForAgent(baseBot.mcp_servers, agentType)
        setMcpConfig(JSON.stringify(adaptedConfig, null, 2))
      } else {
        setMcpConfig(JSON.stringify(baseBot.mcp_servers, null, 2))
      }
    } else {
      setMcpConfig('')
    }

    setSelectedSkills(baseBot?.skills || [])
    setDefaultKnowledgeBaseRefs(baseBot?.default_knowledge_base_refs || [])
    setPreloadSkills(baseBot?.preload_skills || [])
    setSelectedSkillRefs(baseBot?.skill_refs || {})
    setAgentConfigError(false)

    if (baseBot?.agent_config) {
      // Remove protocol from display - it's managed separately via dropdown
      setAgentConfig(getAgentConfigWithoutProtocol(baseBot.agent_config))
    } else {
      setAgentConfig('')
    }
  }, [editingBotId, baseBot, shells])

  // Initialize model-related data after agents and models are loaded
  useEffect(() => {
    // Check if agent_config is empty or doesn't exist
    const hasValidConfig = baseBot?.agent_config && Object.keys(baseBot.agent_config).length > 0

    if (!hasValidConfig) {
      // Default to dropdown (predefined model) mode when no config exists
      setIsCustomModel(false)
      setSelectedModel('')
      setSelectedModelNamespace(undefined)
      setSelectedProtocol('')
      setRestrictModels(false)
      setAllowedModels([])
      return
    }

    const isPredefined = isPredefinedModel(baseBot.agent_config)
    setIsCustomModel(!isPredefined)

    if (isPredefined) {
      const modelName = getModelFromConfig(baseBot.agent_config)
      const modelNamespace = getModelNamespaceFromConfig(baseBot.agent_config)
      setSelectedModel(modelName)
      setSelectedModelNamespace(modelNamespace)
      setSelectedProtocol('')
      // Restore allowed_models whitelist
      const savedAllowedModels = getAllowedModelsFromConfig(
        baseBot.agent_config as Record<string, unknown>
      )
      setAllowedModels(savedAllowedModels)
      setRestrictModels(savedAllowedModels.length > 0)
    } else {
      setSelectedModel('')
      setSelectedModelNamespace(undefined)
      // Extract protocol from agent_config for custom configs
      const protocol = ((baseBot.agent_config as Record<string, unknown>).protocol as string) || ''
      setSelectedProtocol(protocol)
      setRestrictModels(false)
      setAllowedModels([])
    }
  }, [baseBot])

  const handleBack = useCallback(() => {
    onClose()
  }, [onClose])

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return

      handleBack()
    }

    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [handleBack])

  // Validate bot form data
  const validateBot = useCallback((): BotValidationResult => {
    if (!botName.trim() || !agentName.trim()) {
      return { isValid: false, error: t('common:bot.errors.required') }
    }

    // For Dify agent, validate config
    if (isDifyAgent) {
      const trimmedConfig = agentConfig.trim()
      if (!trimmedConfig) {
        return { isValid: false, error: t('common:bot.errors.agent_config_json') }
      }
      try {
        const parsed = JSON.parse(trimmedConfig)
        const env = (parsed as Record<string, unknown>)?.env as Record<string, unknown> | undefined
        if (!env?.DIFY_API_KEY || !env?.DIFY_BASE_URL) {
          return { isValid: false, error: t('common:bot.errors.dify_required_fields') }
        }
      } catch {
        return { isValid: false, error: t('common:bot.errors.agent_config_json') }
      }
    } else if (isCustomModel) {
      if (!selectedProtocol) {
        return { isValid: false, error: t('common:bot.errors.protocol_required') }
      }
      const trimmedConfig = agentConfig.trim()
      if (!trimmedConfig) {
        return { isValid: false, error: t('common:bot.errors.agent_config_json') }
      }
      try {
        JSON.parse(trimmedConfig)
      } catch {
        return { isValid: false, error: t('common:bot.errors.agent_config_json') }
      }
    }

    // Validate MCP config if present (not for Dify)
    if (!isDifyAgent && mcpConfig.trim()) {
      try {
        JSON.parse(mcpConfig)
      } catch {
        return { isValid: false, error: t('common:bot.errors.mcp_config_json') }
      }
    }

    // Rule C: If restrictModels is on with a non-empty whitelist, selectedModel must be set and in the list
    if (!isDifyAgent && !isCustomModel && restrictModels && allowedModels.length > 0) {
      if (!selectedModel) {
        return {
          isValid: false,
          error: t('settings:bot.errors.default_model_required_when_restrict'),
        }
      }
      const isInAllowed = allowedModels.some(m => m.name === selectedModel)
      if (!isInAllowed) {
        return {
          isValid: false,
          error: t('settings:bot.errors.default_model_must_be_in_allowed'),
        }
      }
    }

    return { isValid: true }
  }, [
    botName,
    agentName,
    isDifyAgent,
    agentConfig,
    isCustomModel,
    selectedProtocol,
    mcpConfig,
    t,
    restrictModels,
    allowedModels,
    selectedModel,
  ])

  // Get bot form data for external use
  const getBotData = useCallback((): BotFormData | null => {
    const validation = validateBot()
    if (!validation.isValid) {
      return null
    }

    let parsedAgentConfig: Record<string, unknown> = {}

    if (isDifyAgent) {
      parsedAgentConfig = JSON.parse(agentConfig.trim())
    } else if (isCustomModel) {
      const configObj = JSON.parse(agentConfig.trim())
      parsedAgentConfig = { ...configObj, protocol: selectedProtocol }
    } else {
      // createPredefinedModelConfig returns null if selectedModel is empty
      const modelConfig = createPredefinedModelConfig(
        selectedModel,
        selectedModelType,
        selectedModelNamespace,
        restrictModels ? allowedModels : undefined
      )
      parsedAgentConfig = modelConfig ?? {}
    }

    let parsedMcpConfig: Record<string, unknown> = {}
    if (!isDifyAgent && mcpConfig.trim()) {
      parsedMcpConfig = JSON.parse(mcpConfig)
      if (parsedMcpConfig && agentName && isValidAgentType(agentName)) {
        parsedMcpConfig = adaptMcpConfigForAgent(parsedMcpConfig, agentName)
      }
    }

    return {
      name: botName.trim(),
      shell_name: agentName.trim(),
      agent_config: parsedAgentConfig,
      system_prompt: isDifyAgent ? '' : prompt.trim() || '',
      mcp_servers: parsedMcpConfig,
      default_knowledge_base_refs: defaultKnowledgeBaseRefs,
      skills: selectedSkills.length > 0 ? selectedSkills : [],
      skill_refs: buildSkillRefsFromSelection(
        selectedSkills,
        selectedSkillRefs,
        allSkills,
        scope,
        groupName
      ),
      preload_skills: preloadSkills.length > 0 ? preloadSkills : [],
      preload_skill_refs: buildSkillRefsFromSelection(
        preloadSkills,
        selectedSkillRefs,
        allSkills,
        scope,
        groupName
      ),
    }
  }, [
    validateBot,
    isDifyAgent,
    agentConfig,
    isCustomModel,
    selectedProtocol,
    selectedModel,
    selectedModelType,
    mcpConfig,
    agentName,
    botName,
    defaultKnowledgeBaseRefs,
    prompt,
    selectedSkills,
    selectedSkillRefs,
    preloadSkills,
    allSkills,
    scope,
    groupName,
    selectedModelNamespace,
    restrictModels,
    allowedModels,
  ])

  // Save bot and return the bot id
  const saveBot = useCallback(async (): Promise<number | null> => {
    const validation = validateBot()
    if (!validation.isValid) {
      toast({
        variant: 'destructive',
        title: validation.error,
      })
      return null
    }

    const botData = getBotData()
    if (!botData) {
      return null
    }

    setBotSaving(true)
    try {
      if (scope === 'public') {
        // For public scope, use public resource API
        const publicBotData: PublicBotFormData = {
          name: botData.name,
          shell_name: botData.shell_name,
          agent_config: botData.agent_config,
          system_prompt: botData.system_prompt,
          mcp_servers: botData.mcp_servers,
          skills: botData.skills,
          namespace: 'default',
        }

        if (editingBotId && editingBotId > 0) {
          const updated = await publicResourceApis.updatePublicBot(editingBotId, publicBotData)
          setBots(prev => prev.map(b => (b.id === editingBotId ? updated : b)))
          return updated.id
        } else {
          const created = await publicResourceApis.createPublicBot(publicBotData)
          setBots(prev => [created, ...prev])
          return created.id
        }
      } else {
        // For other scopes, use regular bot API
        const botReq: CreateBotRequest = {
          name: botData.name,
          shell_name: botData.shell_name,
          agent_config: botData.agent_config,
          system_prompt: botData.system_prompt,
          mcp_servers: botData.mcp_servers,
          default_knowledge_base_refs: botData.default_knowledge_base_refs,
          skills: botData.skills,
          skill_refs: botData.skill_refs,
          preload_skills: botData.preload_skills,
          preload_skill_refs: botData.preload_skill_refs,
          namespace: scope === 'group' && groupName ? groupName : undefined,
        }

        if (editingBotId && editingBotId > 0) {
          const updated = await botApis.updateBot(editingBotId, botReq as UpdateBotRequest)
          setBots(prev => prev.map(b => (b.id === editingBotId ? updated : b)))
          return updated.id
        } else {
          const created = await botApis.createBot(botReq)
          setBots(prev => [created, ...prev])
          return created.id
        }
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('common:bot.errors.save_failed'),
      })
      return null
    } finally {
      setBotSaving(false)
    }
  }, [validateBot, getBotData, editingBotId, setBots, toast, t, scope, groupName])

  // Expose methods via ref
  // Use a stable object reference to avoid infinite loops with React 19 and Radix UI
  const refMethods = useMemo(
    () => ({
      getBotData,
      validateBot,
      saveBot,
    }),
    [getBotData, validateBot, saveBot]
  )

  useImperativeHandle(ref, () => refMethods, [refMethods])

  // Save logic
  const handleSave = async () => {
    // Use validateBot() as single source of truth for all validation rules
    const validation = validateBot()
    if (!validation.isValid) {
      toast({
        variant: 'destructive',
        title: validation.error,
      })
      return
    }

    let parsedAgentConfig: unknown = undefined

    // For Dify agent, always use custom model configuration
    if (isDifyAgent) {
      const trimmedConfig = agentConfig.trim()
      try {
        parsedAgentConfig = JSON.parse(trimmedConfig)
        setAgentConfigError(false)
      } catch {
        setAgentConfigError(true)
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.agent_config_json'),
        })
        return
      }
    } else if (isCustomModel) {
      // Non-Dify custom model configuration
      const trimmedConfig = agentConfig.trim()
      try {
        const configObj = JSON.parse(trimmedConfig)
        // Add protocol to the config
        parsedAgentConfig = { ...configObj, protocol: selectedProtocol }
        setAgentConfigError(false)
      } catch {
        setAgentConfigError(true)
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.agent_config_json'),
        })
        return
      }
    } else {
      // Use createPredefinedModelConfig to include bind_model_type and namespace
      // Returns null if selectedModel is empty, meaning no model binding
      const modelConfig = createPredefinedModelConfig(
        selectedModel,
        selectedModelType,
        selectedModelNamespace,
        restrictModels ? allowedModels : undefined
      )
      parsedAgentConfig = modelConfig ?? {}
    }

    let parsedMcpConfig: Record<string, unknown> | null = null

    // Skip MCP config for Dify agent
    if (!isDifyAgent && mcpConfig.trim()) {
      try {
        parsedMcpConfig = JSON.parse(mcpConfig)
        // Adapt MCP config types based on selected agent
        if (parsedMcpConfig && agentName) {
          if (isValidAgentType(agentName)) {
            parsedMcpConfig = adaptMcpConfigForAgent(parsedMcpConfig, agentName)
          } else {
            console.warn(`Unknown agent type "${agentName}", skipping MCP config adaptation`)
          }
        }
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:bot.errors.mcp_config_json'),
        })
        return
      }
    }

    setBotSaving(true)
    try {
      if (scope === 'public') {
        // For public scope, use public resource API
        const publicBotData: PublicBotFormData = {
          name: botName.trim(),
          shell_name: agentName.trim(),
          agent_config: parsedAgentConfig as Record<string, unknown>,
          system_prompt: isDifyAgent ? '' : prompt.trim() || '',
          mcp_servers: parsedMcpConfig ?? {},
          skills: selectedSkills.length > 0 ? selectedSkills : [],
          namespace: 'default',
        }

        if (editingBotId && editingBotId > 0) {
          const updated = await publicResourceApis.updatePublicBot(editingBotId, publicBotData)
          setBots(prev => prev.map(b => (b.id === editingBotId ? updated : b)))
        } else {
          const created = await publicResourceApis.createPublicBot(publicBotData)
          setBots(prev => [created, ...prev])
        }
      } else {
        // For other scopes, use regular bot API
        const botReq: CreateBotRequest = {
          name: botName.trim(),
          shell_name: agentName.trim(), // Use shell_name instead of shell_type
          agent_config: parsedAgentConfig as Record<string, unknown>,
          system_prompt: isDifyAgent ? '' : prompt.trim() || '', // Clear system_prompt for Dify
          mcp_servers: parsedMcpConfig ?? {},
          default_knowledge_base_refs: defaultKnowledgeBaseRefs,
          skills: selectedSkills.length > 0 ? selectedSkills : [],
          skill_refs: buildSkillRefsFromSelection(
            selectedSkills,
            selectedSkillRefs,
            allSkills,
            scope,
            groupName
          ),
          preload_skills: preloadSkills.length > 0 ? preloadSkills : [],
          preload_skill_refs: buildSkillRefsFromSelection(
            preloadSkills,
            selectedSkillRefs,
            allSkills,
            scope,
            groupName
          ),
          namespace: scope === 'group' && groupName ? groupName : undefined,
        }

        if (editingBotId && editingBotId > 0) {
          // Edit existing bot
          const updated = await botApis.updateBot(editingBotId, botReq as UpdateBotRequest)
          setBots(prev => prev.map(b => (b.id === editingBotId ? updated : b)))
        } else {
          // Create new bot
          const created = await botApis.createBot(botReq)
          setBots(prev => [created, ...prev])
        }
      }
      onClose()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('common:bot.errors.save_failed'),
      })
    } finally {
      setBotSaving(false)
    }
  }
  return (
    <div
      className={`flex flex-col w-full bg-surface rounded-lg px-2 py-4 overflow-hidden ${embedded ? 'h-full min-h-0' : 'min-h-[650px]'}`}
    >
      {/* Top navigation bar */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        {!embedded ? (
          <button
            onClick={handleBack}
            className="flex items-center text-text-muted hover:text-text-primary text-base"
            title={t('common:common.back')}
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
            {t('common:common.back')}
          </button>
        ) : (
          <div /> /* Placeholder for flex spacing */
        )}
        {!hideActions &&
          (readOnly ? (
            <Button onClick={onEditClick} variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              {t('common:actions.edit')}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              {embedded && onCancelEdit && (
                <Button onClick={onCancelEdit} variant="outline">
                  {t('common:common.cancel')}
                </Button>
              )}
              <Button
                onClick={handleSave}
                disabled={botSaving}
                variant="primary"
                data-testid="save-button"
              >
                {botSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {botSaving ? t('common:actions.saving') : t('common:actions.save')}
              </Button>
            </div>
          ))}
      </div>

      {/* Main content area - using vertical layout */}
      <div className="flex flex-col gap-4 flex-1 mx-2 min-h-0 overflow-y-auto">
        <div className={`flex flex-col space-y-3 w-full flex-shrink-0`}>
          {/* Bot Name and Agent in one row */}
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Bot Name */}
            <div className="flex flex-col flex-1">
              <div className="flex items-center mb-1">
                <label className="block text-lg font-semibold text-text-primary">
                  {t('common:bot.name')} <span className="text-red-400">*</span>
                </label>
              </div>
              <Input
                value={botName}
                onChange={e => setBotName(e.target.value)}
                placeholder={t('common:bot.name_placeholder')}
                disabled={readOnly}
                className={`text-base ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
              />
            </div>

            {/* Agent */}
            <div className="flex flex-col flex-1">
              <div className="flex items-center mb-1">
                <label className="block text-lg font-semibold text-text-primary">
                  {t('common:bot.agent')} <span className="text-red-400">*</span>
                </label>
                {/* Help Icon */}
                <button
                  type="button"
                  onClick={() => handleOpenShellDocs()}
                  className="ml-2 text-text-muted hover:text-primary transition-colors"
                  title={t('common:bot.view_shell_config_guide')}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </button>
              </div>
              <Select
                value={agentName}
                onValueChange={value => {
                  if (readOnly) return
                  if (value !== agentName) {
                    setIsCustomModel(false)
                    setSelectedModel('')
                    setAgentConfig('')
                    setAgentConfigError(false)
                    setModels([])
                    // Clear protocol when switching agent type since protocols are filtered by agent
                    setSelectedProtocol('')

                    // Adapt MCP config when switching agent type
                    if (mcpConfig.trim()) {
                      try {
                        const currentMcpConfig = JSON.parse(mcpConfig)
                        if (isValidAgentType(value)) {
                          const adaptedConfig = adaptMcpConfigForAgent(currentMcpConfig, value)
                          setMcpConfig(JSON.stringify(adaptedConfig, null, 2))
                        } else {
                          console.warn(
                            `Unknown agent type "${value}", skipping MCP config adaptation`
                          )
                        }
                      } catch (error) {
                        // If parsing fails, keep the original config
                        console.warn('Failed to adapt MCP config on agent change:', error)
                      }
                    }
                  }
                  setAgentName(value)
                }}
                disabled={loadingShells || readOnly}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('common:bot.agent_select')} />
                </SelectTrigger>
                <SelectContent>
                  {shells.map(shell => (
                    <SelectItem key={`${shell.name}-${shell.type}`} value={shell.name}>
                      {shell.displayName || shell.name}
                      {shell.type === 'user' && (
                        <span className="ml-1 text-xs text-text-muted">
                          [{t('common:bot.custom_shell', '自定义')}]
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Conditional rendering based on agent type */}
          {isDifyAgent ? (
            /* Dify Mode: Show specialized Dify configuration */
            <DifyBotConfig
              agentConfig={agentConfig}
              onAgentConfigChange={setAgentConfig}
              toast={toast}
              readOnly={readOnly}
            />
          ) : (
            /* Normal Mode: Show standard configuration options */
            <>
              {/* Agent Config - Default Model label row, then selector + switch row */}
              <div className="flex flex-col">
                {/* Label row */}
                <div className="flex items-center mb-1">
                  <label className="block text-lg font-semibold text-text-primary">
                    {t('common:bot.agent_config')}
                  </label>
                  {/* Help Icon */}
                  <button
                    type="button"
                    onClick={() => handleOpenModelDocs()}
                    className="ml-2 text-text-muted hover:text-primary transition-colors"
                    title={t('common:bot.view_model_config_guide')}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </button>
                </div>
                {/* Model selector + Restrict Models switch on same row */}
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Select
                      value={
                        selectedModel
                          ? `${selectedModel}:${selectedModelType || ''}:${selectedModelNamespace || 'default'}`
                          : '__none__'
                      }
                      onValueChange={value => {
                        if (value === '__none__') {
                          setSelectedModel('')
                          setSelectedModelType(undefined)
                          setSelectedModelNamespace(undefined)
                          return
                        }
                        const [modelName, modelType, modelNamespace] = value.split(':')
                        setSelectedModel(modelName)
                        setSelectedModelType((modelType as ModelTypeEnum) || undefined)
                        setSelectedModelNamespace(modelNamespace || 'default')
                      }}
                      disabled={loadingModels || !agentName || readOnly}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={
                            !agentName
                              ? t('common:bot.select_executor_first')
                              : t('common:bot.model_select')
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          <span className="text-text-muted">
                            {t('common:bot.no_model_binding')}
                          </span>
                        </SelectItem>
                        {models.length === 0 ? (
                          <div className="py-2 px-3 text-sm text-text-muted text-center">
                            {t('common:bot.no_available_models')}
                          </div>
                        ) : (
                          models.map(model => (
                            <SelectItem
                              key={`${model.name}:${model.type}:${model.namespace || 'default'}`}
                              value={`${model.name}:${model.type}:${model.namespace || 'default'}`}
                            >
                              {model.displayName || model.name}
                              {model.type === 'public' && (
                                <span className="ml-1 text-xs text-text-muted">
                                  [{t('common:bot.public_model', '公共')}]
                                </span>
                              )}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* Restrict Models Switch */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-sm text-text-secondary whitespace-nowrap">
                      {t('settings:bot.allowed_models.label')}
                    </span>
                    <Switch
                      checked={restrictModels}
                      disabled={readOnly}
                      onCheckedChange={(checked: boolean) => {
                        if (readOnly) return
                        setRestrictModels(checked)
                        if (!checked) {
                          setAllowedModels([])
                        } else {
                          // Rule A: When enabling restrict, clear selectedModel if not in allowedModels
                          if (selectedModel && allowedModels.length > 0) {
                            const isInAllowed = allowedModels.some(m => m.name === selectedModel)
                            if (!isInAllowed) {
                              setSelectedModel('')
                              setSelectedModelType(undefined)
                              setSelectedModelNamespace(undefined)
                            }
                          }
                        }
                      }}
                    />
                  </div>
                </div>

                {/* Allowed Models multi-select - shown when restrictModels is on */}
                {restrictModels && (
                  <div className="mt-1">
                    <p className="text-xs text-text-muted mb-2">
                      {t('settings:bot.allowed_models.description')}
                    </p>
                    <Select
                      value=""
                      onValueChange={value => {
                        if (!value || value === '__none__') return
                        const [modelName, modelType, modelNamespace] = value.split(':')
                        const alreadyAdded = allowedModels.some(m => m.name === modelName)
                        if (!alreadyAdded) {
                          setAllowedModels([
                            ...allowedModels,
                            {
                              name: modelName,
                              type: (modelType as AllowedModelRef['type']) || 'public',
                              namespace: modelNamespace || 'default',
                            },
                          ])
                        }
                      }}
                      disabled={readOnly || loadingModels || !agentName}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t('settings:bot.allowed_models.placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map(model => {
                          const isAdded = allowedModels.some(m => m.name === model.name)
                          return (
                            <SelectItem
                              key={`${model.name}:${model.type}:${model.namespace || 'default'}`}
                              value={`${model.name}:${model.type}:${model.namespace || 'default'}`}
                              disabled={isAdded}
                            >
                              {model.displayName || model.name}
                              {model.type === 'public' && (
                                <span className="ml-1 text-xs text-text-muted">
                                  [{t('common:bot.public_model', '公共')}]
                                </span>
                              )}
                              {isAdded && <span className="ml-1 text-xs text-text-muted">✓</span>}
                            </SelectItem>
                          )
                        })}
                      </SelectContent>
                    </Select>
                    {allowedModels.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {allowedModels.map(m => {
                          const modelInfo = models.find(model => model.name === m.name)
                          return (
                            <div
                              key={m.name}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-sm bg-muted"
                            >
                              <span>{modelInfo?.displayName || m.name}</span>
                              {!readOnly && (
                                <button
                                  onClick={() => {
                                    setAllowedModels(allowedModels.filter(x => x.name !== m.name))
                                    // Rule B: If removed model is the current default, clear selectedModel
                                    if (selectedModel === m.name) {
                                      setSelectedModel('')
                                      setSelectedModelType(undefined)
                                      setSelectedModelNamespace(undefined)
                                    }
                                  }}
                                  className="text-text-muted hover:text-text-primary"
                                >
                                  <XIcon className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-text-muted mt-2">
                        {t('settings:bot.allowed_models.empty')}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Skills Selection - Show for agents that support skills (ClaudeCode, Chat) */}
              {supportsSkills && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center">
                      <label className="block text-base font-medium text-text-primary">
                        {t('common:skills.skills_section')}
                      </label>
                      <span className="text-xs text-text-muted ml-2">
                        {t('common:skills.skills_optional')}
                      </span>
                      {/* Help Icon for Skills */}
                      <a
                        href="https://www.claude.com/blog/skills"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 text-text-muted hover:text-primary transition-colors"
                        title="Learn more about Claude Skills"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-5 w-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      </a>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSkillManagementModalOpen(true)}
                      className="text-xs"
                    >
                      <SettingsIcon className="w-3 h-3 mr-1" />
                      {t('common:skills.manage_skills_button')}
                    </Button>
                  </div>
                  <div className="bg-base rounded-md p-2 min-h-[80px]">
                    {loadingSkills ? (
                      <div className="text-sm text-text-muted">
                        {t('common:skills.loading_skills')}
                      </div>
                    ) : availableSkills.length === 0 && selectedSkills.length === 0 ? (
                      <div className="text-sm text-text-muted">
                        {t('common:skills.no_skills_available')}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {availableSkills.length > 0 && (
                          <RichSkillSelector
                            skills={availableSkills}
                            selectedSkillNames={selectedSkills}
                            onSelectSkill={skill => {
                              if (readOnly) return
                              if (skill && !selectedSkills.includes(skill.name)) {
                                setSelectedSkills([...selectedSkills, skill.name])
                                setSelectedSkillRefs(prev => ({
                                  ...prev,
                                  [skill.name]: {
                                    skill_id: skill.id,
                                    namespace: skill.namespace || 'default',
                                    is_public: skill.is_public || false,
                                  },
                                }))
                              }
                            }}
                            placeholder={t('common:skills.select_skill_to_add')}
                            disabled={readOnly}
                            readOnly={readOnly}
                          />
                        )}

                        {selectedSkills.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {selectedSkills.map(skillName => {
                              const skillRef = selectedSkillRefs[skillName]
                              const skill =
                                allSkills.find(s => s.id === skillRef?.skill_id) ||
                                allSkills.find(s => s.name === skillName)
                              const isPreloaded = preloadSkills.includes(skillName)
                              // All skills can be preloaded when shell supports it
                              const canPreload = supportsPreloadSkills
                              return (
                                <div
                                  key={skillName}
                                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-sm ${
                                    isPreloaded && canPreload
                                      ? 'bg-primary/10 border border-primary'
                                      : 'bg-muted'
                                  }`}
                                >
                                  {canPreload && (
                                    <input
                                      type="checkbox"
                                      checked={isPreloaded}
                                      onChange={e => {
                                        if (readOnly) return
                                        if (e.target.checked) {
                                          setPreloadSkills([...preloadSkills, skillName])
                                        } else {
                                          setPreloadSkills(
                                            preloadSkills.filter(s => s !== skillName)
                                          )
                                        }
                                      }}
                                      disabled={readOnly}
                                      title={t('common:skills.preload_skills_section')}
                                      className={`w-3.5 h-3.5 rounded border-border text-primary focus:ring-primary ${readOnly ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                                    />
                                  )}
                                  <span
                                    className={
                                      isPreloaded && canPreload ? 'text-primary' : undefined
                                    }
                                  >
                                    {skill?.displayName || skillName}
                                  </span>
                                  <button
                                    onClick={() => {
                                      if (readOnly) return
                                      setSelectedSkills(selectedSkills.filter(s => s !== skillName))
                                      setSelectedSkillRefs(prev => {
                                        const next = { ...prev }
                                        delete next[skillName]
                                        return next
                                      })
                                      // Also remove from preload if it was preloaded
                                      if (isPreloaded) {
                                        setPreloadSkills(preloadSkills.filter(s => s !== skillName))
                                      }
                                    }}
                                    disabled={readOnly}
                                    className={`text-text-muted hover:text-text-primary ${readOnly ? 'cursor-not-allowed opacity-50' : ''}`}
                                  >
                                    <XIcon className="w-3 h-3" />
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        )}

                        {/* Preload hint - show when supportsPreloadSkills and there are selected skills */}
                        {supportsPreloadSkills && selectedSkills.length > 0 && (
                          <div className="text-xs text-text-muted">
                            {t('common:skills.preload_hint')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {scope !== 'public' && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center">
                      <label className="block text-base font-medium text-text-primary">
                        {t('common:bot.default_knowledge_bases')}
                      </label>
                      <span className="text-xs text-text-muted ml-2">
                        {t('common:bot.default_knowledge_bases_optional')}
                      </span>
                    </div>
                  </div>
                  <div className="bg-base rounded-md p-2 min-h-[80px]">
                    <KnowledgeBaseMultiSelector
                      value={defaultKnowledgeBaseRefs}
                      onChange={setDefaultKnowledgeBaseRefs}
                      disabled={readOnly}
                    />
                  </div>
                </div>
              )}

              {/* MCP Config */}
              <McpConfigSection
                mcpConfig={mcpConfig}
                onMcpConfigChange={setMcpConfig}
                agentType={mcpAgentType}
                readOnly={readOnly}
                toast={toast}
              />
            </>
          )}
        </div>

        {/* Prompt area - below the config section */}
        {!isDifyAgent && (
          <div className="w-full flex flex-col min-h-0">
            <div className="mb-1 flex-shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center">
                  <label className="block text-base font-medium text-text-primary">
                    {t('common:bot.prompt')}
                  </label>
                  <span className="text-xs text-text-muted ml-2">AI prompt</span>
                </div>
                {/* Fine-tune button */}
                {!readOnly && prompt.trim() && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPromptFineTuneOpen(true)}
                    className="text-xs gap-1.5"
                  >
                    <Wand2 className="w-3.5 h-3.5" />
                    {t('common:bot.fine_tune_prompt')}
                  </Button>
                )}
              </div>
            </div>

            {/* textarea occupies all space in the second row */}
            <Textarea
              value={prompt}
              onChange={e => {
                if (readOnly) return
                setPrompt(e.target.value)
              }}
              disabled={readOnly}
              placeholder={t('common:bot.prompt_placeholder')}
              className={`text-base resize-y custom-scrollbar min-h-[200px] flex-grow ${readOnly ? 'cursor-not-allowed opacity-70' : ''}`}
            />
          </div>
        )}
      </div>

      {/* Skill Management Modal */}
      <SkillManagementModal
        open={skillManagementModalOpen}
        onClose={() => setSkillManagementModalOpen(false)}
        scope={scope}
        groupName={groupName}
        onSkillsChange={() => {
          // Reload skills list when skills are changed
          const fetchSkills = async () => {
            try {
              // For public scope, use fetchPublicSkillsList; otherwise use fetchUnifiedSkillsList
              const skillsData =
                scope === 'public'
                  ? await fetchPublicSkillsList()
                  : await fetchUnifiedSkillsList({
                      scope: scope,
                      groupName: groupName,
                    })
              setAllSkills(skillsData)
              // Filter skills based on current shell type
              setAvailableSkills(filterSkillsByShellType(filterSelectableSkills(skillsData)))
            } catch {
              toast({
                variant: 'destructive',
                title: t('common:skills.loading_failed'),
              })
            }
          }
          fetchSkills()
        }}
      />

      {/* Prompt Fine-tune Dialog */}
      <PromptFineTuneDialog
        open={promptFineTuneOpen}
        onOpenChange={setPromptFineTuneOpen}
        initialPrompt={prompt}
        onSave={newPrompt => {
          setPrompt(newPrompt)
        }}
        modelName={selectedModel}
      />

      {/* Mobile responsive styles */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
          @media (max-width: 640px) {
            /* Mobile specific optimizations */
            .flex.flex-col.w-full.bg-surface.rounded-lg {
              padding: 0.5rem !important;
              border-radius: 0.5rem !important;
              max-width: 100vw !important;
              overflow-x: hidden !important;
              height: 100vh !important;
              min-height: 100vh !important;
              max-height: 100vh !important;
            }

            /* Prevent horizontal scroll on mobile */
            body, html {
              overflow-x: hidden !important;
            }

            /* Ensure container doesn't cause horizontal scroll */
            .max-w-full {
              max-width: 100vw !important;
              overflow-x: hidden !important;
            }

            .overflow-hidden {
              overflow-x: hidden !important;
              overflow-y: auto !important;
            }

            /* Fix main container height on mobile */
            .flex.flex-col.w-full.bg-surface.rounded-lg {
              height: 100vh !important;
              min-height: 100vh !important;
            }

            /* Fix content area to fill remaining height */
            .flex.flex-col.lg\\:flex-row.gap-4.flex-grow.mx-2.min-h-0.overflow-hidden {
              height: calc(100vh - 120px) !important;
              min-height: calc(100vh - 120px) !important;
            }

            /* Adjust input and textarea sizes for mobile */
            input[type="text"] {
              font-size: 16px !important;
              padding: 0.75rem 1rem !important;
              height: auto !important;
              max-width: 100% !important;
              box-sizing: border-box !important;
            }

            textarea {
              font-size: 16px !important;
              padding: 0.75rem 1rem !important;
              min-height: 150px !important;
              max-width: 100% !important;
              box-sizing: border-box !important;
              resize: vertical !important;
              white-space: pre-wrap !important;
              word-wrap: break-word !important;
            }

            /* Adjust button sizes */
            .ant-btn {
              min-height: 40px !important;
              font-size: 14px !important;
              max-width: 100% !important;
              white-space: nowrap !important;
              overflow: hidden !important;
              text-overflow: ellipsis !important;
            }

            /* Adjust select component */
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

            /* Adjust labels */
            label {
              font-size: 16px !important;
              max-width: 100% !important;
              word-wrap: break-word !important;
            }

            /* Reduce spacing on mobile */
            .space-y-3 > * + * {
              margin-top: 0.75rem !important;
            }

            /* Fix overflow issues */
            .overflow-y-auto {
              overflow-x: hidden !important;
              overflow-y: auto !important;
            }

            /* Fix flex container overflow */
            .flex.flex-col {
              min-width: 0 !important;
              max-width: 100% !important;
            }

            .flex-grow {
              min-width: 0 !important;
              max-width: 100% !important;
              flex: 1 !important;
            }

            /* Fix grid and layout overflow */
            .grid {
              max-width: 100% !important;
              overflow-x: hidden !important;
            }

            /* Fix text overflow in containers */
            .truncate {
              overflow: hidden !important;
              text-overflow: ellipsis !important;
              white-space: nowrap !important;
              max-width: 100% !important;
            }

            /* Fix long text in tooltips */
            .ant-tooltip-inner {
              max-width: 80vw !important;
              word-wrap: break-word !important;
              white-space: normal !important;
            }
          }
        `,
        }}
      />
    </div>
  )
}

const BotEdit = forwardRef(BotEditInner)

export default BotEdit
