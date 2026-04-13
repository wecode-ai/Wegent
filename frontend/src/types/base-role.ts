// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Base Role type definitions
 * Unified role system for groups, knowledge bases, and other resources
 */

// ============================================================================
// Base Role Type Definition
// ============================================================================

/**
 * Base role type representing all possible roles in the system
 * Used across groups, knowledge bases, and other resources
 */
export type BaseRole = 'Owner' | 'Maintainer' | 'Developer' | 'Reporter' | 'RestrictedAnalyst'

// ============================================================================
// Backward Compatible Aliases
// ============================================================================

/**
 * @deprecated Use BaseRole instead. Kept for backward compatibility.
 */
export type GroupRole = BaseRole

/**
 * @deprecated Use BaseRole instead. Kept for backward compatibility.
 */
export type MemberRole = BaseRole

/**
 * @deprecated Use BaseRole instead. Kept for backward compatibility.
 */
export type ResourceRole = BaseRole

// ============================================================================
// Role Constants
// ============================================================================

/**
 * All available base roles
 */
export const BASE_ROLES: BaseRole[] = [
  'Owner',
  'Maintainer',
  'Developer',
  'Reporter',
  'RestrictedAnalyst',
]

/**
 * Roles that can be assigned to members (excludes Owner)
 * Owner can only be transferred, not assigned directly
 */
export const ASSIGNABLE_ROLES: BaseRole[] = [
  'Maintainer',
  'Developer',
  'Reporter',
  'RestrictedAnalyst',
]

/**
 * Roles that have management permissions (Owner and Maintainer)
 */
export const MANAGER_ROLES: BaseRole[] = ['Owner', 'Maintainer']

/**
 * Roles that have edit permissions (Owner, Maintainer, Developer)
 */
export const EDITOR_ROLES: BaseRole[] = ['Owner', 'Maintainer', 'Developer']

// ============================================================================
// Role Hierarchy
// ============================================================================

/**
 * Role hierarchy for permission comparison
 * Higher number = more permissions
 */
export const ROLE_HIERARCHY: Record<BaseRole, number> = {
  Owner: 5,
  Maintainer: 4,
  Developer: 3,
  Reporter: 2,
  RestrictedAnalyst: 1,
}

// ============================================================================
// Display Names
// ============================================================================

/**
 * Role display names in Chinese
 */
export const ROLE_DISPLAY_NAMES: Record<BaseRole, string> = {
  Owner: '创建者',
  Maintainer: '管理员',
  Developer: '开发者',
  Reporter: '使用者',
  RestrictedAnalyst: '访客',
}

/**
 * Role display names in English
 */
export const ROLE_DISPLAY_NAMES_EN: Record<BaseRole, string> = {
  Owner: 'Owner',
  Maintainer: 'Maintainer',
  Developer: 'Developer',
  Reporter: 'Reporter',
  RestrictedAnalyst: 'Restricted Analyst',
}

// ============================================================================
// Permission Utility Functions
// ============================================================================

/**
 * Check if a role has permission to perform an action based on hierarchy
 * @param userRole - The role of the user
 * @param requiredRole - The minimum role required
 * @returns boolean indicating if user has permission
 */
export function hasPermission(
  userRole: BaseRole | null | undefined,
  requiredRole: BaseRole
): boolean {
  if (!userRole) return false
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole]
}

/**
 * Check if a role can manage members (add, remove, update roles)
 * Requires Owner or Maintainer role
 */
export function canManageMembers(role: BaseRole | null | undefined): boolean {
  return role === 'Owner' || role === 'Maintainer'
}

/**
 * Check if a role can edit content
 * Requires Owner, Maintainer, or Developer role
 */
export function canEditContent(role: BaseRole | null | undefined): boolean {
  return role === 'Owner' || role === 'Maintainer' || role === 'Developer'
}

/**
 * Check if a role can delete resources
 * Requires Owner or Maintainer role
 */
export function canDelete(role: BaseRole | null | undefined): boolean {
  return role === 'Owner' || role === 'Maintainer'
}

/**
 * Check if a user can leave a group/resource
 * Owner cannot leave (must transfer ownership first)
 * Missing role fails closed (returns false)
 */
export function canLeave(role: BaseRole | null | undefined): boolean {
  return !!role && role !== 'Owner'
}

/**
 * Check if a role is Owner
 */
export function isOwner(role: BaseRole | null | undefined): boolean {
  return role === 'Owner'
}

/**
 * Check if a role is Maintainer or higher
 */
export function isManager(role: BaseRole | null | undefined): boolean {
  return role === 'Owner' || role === 'Maintainer'
}

/**
 * Check if a role is Developer or higher
 */
export function isEditor(role: BaseRole | null | undefined): boolean {
  return role === 'Owner' || role === 'Maintainer' || role === 'Developer'
}

/**
 * Compare two roles by hierarchy
 * @returns negative if roleA < roleB, 0 if equal, positive if roleA > roleB
 */
export function compareRoles(roleA: BaseRole, roleB: BaseRole): number {
  return ROLE_HIERARCHY[roleA] - ROLE_HIERARCHY[roleB]
}

/**
 * Get the higher role between two roles
 */
export function getHigherRole(roleA: BaseRole, roleB: BaseRole): BaseRole {
  return ROLE_HIERARCHY[roleA] >= ROLE_HIERARCHY[roleB] ? roleA : roleB
}

/**
 * Check if userRole can manage targetRole (has higher or equal hierarchy)
 * Used for role updates - cannot update someone with equal or higher role
 */
export function canManageRole(
  userRole: BaseRole | null | undefined,
  targetRole: BaseRole | null | undefined
): boolean {
  if (!userRole || !targetRole) return false
  return ROLE_HIERARCHY[userRole] > ROLE_HIERARCHY[targetRole]
}
