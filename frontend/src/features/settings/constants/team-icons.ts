// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { IconType } from 'react-icons'
import {
  FaUsers,
  FaRobot,
  FaUserAstronaut,
  FaUserNinja,
  FaUserSecret,
  FaBrain,
  FaLightbulb,
  FaRocket,
  FaCog,
  FaCode,
  FaTerminal,
  FaDatabase,
  FaCloud,
  FaShieldAlt,
  FaBullseye,
  FaPuzzlePiece,
  FaMagic,
  FaSearch,
  FaChartBar,
  FaBook,
  FaPalette,
  FaWrench,
  FaBolt,
  FaStar,
  FaHeart,
  FaGem,
  FaCrown,
  FaFire,
  FaLeaf,
  FaAnchor,
} from 'react-icons/fa'
import {
  HiOutlineCode,
  HiOutlineChatAlt2,
  HiOutlineSparkles,
  HiOutlineLightningBolt,
  HiOutlineGlobe,
} from 'react-icons/hi'
import {
  AiOutlineTeam,
  AiOutlineRobot,
  AiOutlineExperiment,
  AiOutlineThunderbolt,
  AiOutlineApi,
} from 'react-icons/ai'

export interface TeamIconConfig {
  id: string // Unique identifier
  icon: IconType // React Icon component
  label: string // Display name (for tooltip)
}

export const TEAM_ICONS: TeamIconConfig[] = [
  // Team/User related
  { id: 'users', icon: FaUsers, label: 'Team' },
  { id: 'team', icon: AiOutlineTeam, label: 'Group' },

  // Robot/AI related
  { id: 'robot', icon: FaRobot, label: 'Robot' },
  { id: 'robot-outline', icon: AiOutlineRobot, label: 'Robot Outline' },
  { id: 'astronaut', icon: FaUserAstronaut, label: 'Astronaut' },
  { id: 'ninja', icon: FaUserNinja, label: 'Ninja' },
  { id: 'secret', icon: FaUserSecret, label: 'Secret Agent' },
  { id: 'brain', icon: FaBrain, label: 'Brain' },
  { id: 'experiment', icon: AiOutlineExperiment, label: 'Experiment' },

  // Technology related
  { id: 'code', icon: FaCode, label: 'Code' },
  { id: 'code-outline', icon: HiOutlineCode, label: 'Code Outline' },
  { id: 'terminal', icon: FaTerminal, label: 'Terminal' },
  { id: 'database', icon: FaDatabase, label: 'Database' },
  { id: 'api', icon: AiOutlineApi, label: 'API' },
  { id: 'cloud', icon: FaCloud, label: 'Cloud' },
  { id: 'cog', icon: FaCog, label: 'Settings' },
  { id: 'wrench', icon: FaWrench, label: 'Tools' },

  // Creative/Ideas related
  { id: 'lightbulb', icon: FaLightbulb, label: 'Idea' },
  { id: 'sparkles', icon: HiOutlineSparkles, label: 'Sparkles' },
  { id: 'magic', icon: FaMagic, label: 'Magic' },
  { id: 'palette', icon: FaPalette, label: 'Creative' },

  // Action/Target related
  { id: 'rocket', icon: FaRocket, label: 'Rocket' },
  { id: 'bolt', icon: FaBolt, label: 'Fast' },
  { id: 'lightning', icon: HiOutlineLightningBolt, label: 'Lightning' },
  { id: 'thunder', icon: AiOutlineThunderbolt, label: 'Thunder' },
  { id: 'target', icon: FaBullseye, label: 'Target' },
  { id: 'search', icon: FaSearch, label: 'Search' },

  // Analysis/Data related
  { id: 'chart', icon: FaChartBar, label: 'Analytics' },
  { id: 'book', icon: FaBook, label: 'Knowledge' },
  { id: 'puzzle', icon: FaPuzzlePiece, label: 'Puzzle' },

  // Security/Protection related
  { id: 'shield', icon: FaShieldAlt, label: 'Security' },

  // Communication related
  { id: 'chat', icon: HiOutlineChatAlt2, label: 'Chat' },
  { id: 'globe', icon: HiOutlineGlobe, label: 'Global' },

  // Special/Decorative
  { id: 'star', icon: FaStar, label: 'Star' },
  { id: 'heart', icon: FaHeart, label: 'Heart' },
  { id: 'gem', icon: FaGem, label: 'Gem' },
  { id: 'crown', icon: FaCrown, label: 'Crown' },
  { id: 'fire', icon: FaFire, label: 'Fire' },
  { id: 'leaf', icon: FaLeaf, label: 'Nature' },
  { id: 'anchor', icon: FaAnchor, label: 'Anchor' },
]

export const DEFAULT_TEAM_ICON_ID = 'users'

export function getTeamIconById(id: string | null | undefined): TeamIconConfig {
  return TEAM_ICONS.find(icon => icon.id === id) || TEAM_ICONS[0]
}

export function getTeamIconComponent(id: string | null | undefined): IconType {
  return getTeamIconById(id).icon
}
