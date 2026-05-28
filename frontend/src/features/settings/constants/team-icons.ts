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
  FaBriefcase,
  FaBug,
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
  FaChartLine,
  FaChartPie,
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
  FaAtom,
  FaBalanceScale,
  FaBuilding,
  FaCalculator,
  FaCalendarAlt,
  FaChalkboardTeacher,
  FaClipboardList,
  FaCommentDots,
  FaComments,
  FaCompass,
  FaCreditCard,
  FaDna,
  FaFileAlt,
  FaFingerprint,
  FaFlag,
  FaFlask,
  FaFolderOpen,
  FaGavel,
  FaGraduationCap,
  FaHandshake,
  FaHeadset,
  FaKey,
  FaLaptopCode,
  FaLock,
  FaMapMarkerAlt,
  FaMapSigns,
  FaMicrochip,
  FaMicroscope,
  FaMobileAlt,
  FaMoneyBillWave,
  FaNetworkWired,
  FaPen,
  FaProjectDiagram,
  FaRoute,
  FaServer,
  FaShoppingCart,
  FaSitemap,
  FaStore,
  FaTasks,
  FaWifi,
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
  { id: 'message', icon: FaComments, label: 'Messages' },
  { id: 'discussion', icon: FaCommentDots, label: 'Discussion' },
  { id: 'support', icon: FaHeadset, label: 'Support' },
  { id: 'partnership', icon: FaHandshake, label: 'Partnership' },

  // Workflow/Productivity related
  { id: 'workflow', icon: FaProjectDiagram, label: 'Workflow' },
  { id: 'tasks', icon: FaTasks, label: 'Tasks' },
  { id: 'checklist', icon: FaClipboardList, label: 'Checklist' },
  { id: 'document', icon: FaFileAlt, label: 'Document' },
  { id: 'folder', icon: FaFolderOpen, label: 'Folder' },
  { id: 'sitemap', icon: FaSitemap, label: 'Sitemap' },
  { id: 'briefcase', icon: FaBriefcase, label: 'Briefcase' },

  // Development/Infrastructure related
  { id: 'laptop-code', icon: FaLaptopCode, label: 'Development' },
  { id: 'chip', icon: FaMicrochip, label: 'Chip' },
  { id: 'server', icon: FaServer, label: 'Server' },
  { id: 'network', icon: FaNetworkWired, label: 'Network' },
  { id: 'wifi', icon: FaWifi, label: 'Wireless' },
  { id: 'mobile', icon: FaMobileAlt, label: 'Mobile' },
  { id: 'bug', icon: FaBug, label: 'Debug' },

  // Knowledge/Research related
  { id: 'graduation', icon: FaGraduationCap, label: 'Education' },
  { id: 'teacher', icon: FaChalkboardTeacher, label: 'Teaching' },
  { id: 'flask', icon: FaFlask, label: 'Research' },
  { id: 'dna', icon: FaDna, label: 'Biology' },
  { id: 'atom', icon: FaAtom, label: 'Science' },
  { id: 'microscope', icon: FaMicroscope, label: 'Analysis' },
  { id: 'calculator', icon: FaCalculator, label: 'Calculation' },

  // Special/Decorative
  { id: 'star', icon: FaStar, label: 'Star' },
  { id: 'heart', icon: FaHeart, label: 'Heart' },
  { id: 'gem', icon: FaGem, label: 'Gem' },
  { id: 'crown', icon: FaCrown, label: 'Crown' },
  { id: 'fire', icon: FaFire, label: 'Fire' },
  { id: 'leaf', icon: FaLeaf, label: 'Nature' },
  { id: 'anchor', icon: FaAnchor, label: 'Anchor' },
  { id: 'pen', icon: FaPen, label: 'Writing' },

  // Security/Access related
  { id: 'lock', icon: FaLock, label: 'Lock' },
  { id: 'key', icon: FaKey, label: 'Key' },
  { id: 'fingerprint', icon: FaFingerprint, label: 'Identity' },

  // Business/Operations related
  { id: 'building', icon: FaBuilding, label: 'Organization' },
  { id: 'store', icon: FaStore, label: 'Store' },
  { id: 'cart', icon: FaShoppingCart, label: 'Commerce' },
  { id: 'credit-card', icon: FaCreditCard, label: 'Payment' },
  { id: 'finance', icon: FaMoneyBillWave, label: 'Finance' },
  { id: 'legal', icon: FaBalanceScale, label: 'Legal' },
  { id: 'gavel', icon: FaGavel, label: 'Policy' },
  { id: 'chart-line', icon: FaChartLine, label: 'Growth' },
  { id: 'chart-pie', icon: FaChartPie, label: 'Metrics' },
  { id: 'calendar', icon: FaCalendarAlt, label: 'Schedule' },

  // Navigation/Planning related
  { id: 'map', icon: FaMapSigns, label: 'Map' },
  { id: 'route', icon: FaRoute, label: 'Route' },
  { id: 'compass', icon: FaCompass, label: 'Direction' },
  { id: 'flag', icon: FaFlag, label: 'Flag' },
  { id: 'location', icon: FaMapMarkerAlt, label: 'Location' },
]

export const DEFAULT_TEAM_ICON_ID = 'users'

export function getTeamIconById(id: string | null | undefined): TeamIconConfig {
  return TEAM_ICONS.find(icon => icon.id === id) || TEAM_ICONS[0]
}

export function getTeamIconComponent(id: string | null | undefined): IconType {
  return getTeamIconById(id).icon
}
