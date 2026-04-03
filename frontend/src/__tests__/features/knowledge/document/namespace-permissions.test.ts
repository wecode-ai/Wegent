// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildNamespaceRoleMap,
  canCreateKnowledgeBaseInNamespace,
  canManageKnowledgeBase,
  canManageKnowledgeBaseDocuments,
  canManageKnowledgeBasePermissions,
  canManageKnowledgeDocument,
  canManageNamespace,
} from '@/utils/namespace-permissions'

describe('namespace permissions', () => {
  describe('buildNamespaceRoleMap', () => {
    it('includes only groups with my_role', () => {
      const roleMap = buildNamespaceRoleMap([
        { name: 'engineering', my_role: 'Developer' },
        { name: 'ops', my_role: undefined },
        { name: 'organization', my_role: 'Maintainer' },
      ])

      expect(roleMap.get('engineering')).toBe('Developer')
      expect(roleMap.get('organization')).toBe('Maintainer')
      expect(roleMap.has('ops')).toBe(false)
    })
  })

  describe('canCreateKnowledgeBaseInNamespace', () => {
    it('allows personal namespace creation', () => {
      expect(canCreateKnowledgeBaseInNamespace({ namespace: 'default' })).toBe(true)
    })

    it('allows developer and above in namespace', () => {
      expect(
        canCreateKnowledgeBaseInNamespace({
          namespace: 'engineering',
          namespaceRole: 'Developer',
        })
      ).toBe(true)

      expect(
        canCreateKnowledgeBaseInNamespace({
          namespace: 'engineering',
          namespaceRole: 'Reporter',
        })
      ).toBe(false)
    })

    it('does not allow non-default namespace creation without editor role', () => {
      expect(canCreateKnowledgeBaseInNamespace({ namespace: 'organization' })).toBe(false)
    })
  })

  describe('canManageKnowledgeBase', () => {
    it('returns false when currentUserId is not provided', () => {
      expect(
        canManageKnowledgeBase({
          knowledgeBase: { namespace: 'default', user_id: 1 },
        })
      ).toBe(false)
    })

    it('allows owner of personal knowledge base', () => {
      expect(
        canManageKnowledgeBase({
          currentUserId: 1,
          knowledgeBase: { namespace: 'default', user_id: 1 },
        })
      ).toBe(true)
    })

    it('allows maintainer to manage namespace knowledge base created by others', () => {
      expect(
        canManageKnowledgeBase({
          currentUserId: 2,
          namespaceRole: 'Maintainer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
        })
      ).toBe(true)
    })

    it('allows developer to manage only their own namespace knowledge base', () => {
      expect(
        canManageKnowledgeBase({
          currentUserId: 2,
          namespaceRole: 'Developer',
          knowledgeBase: { namespace: 'engineering', user_id: 2 },
        })
      ).toBe(true)

      expect(
        canManageKnowledgeBase({
          currentUserId: 2,
          namespaceRole: 'Developer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
        })
      ).toBe(false)
    })

    it('allows explicit manager knowledge permission for shared personal knowledge base', () => {
      expect(
        canManageKnowledgeBase({
          currentUserId: 2,
          knowledgeRole: 'Maintainer',
          knowledgeBase: { namespace: 'default', user_id: 1 },
        })
      ).toBe(true)
    })

    it('does not allow knowledge-base management without role or ownership', () => {
      expect(
        canManageKnowledgeBase({
          currentUserId: 2,
          knowledgeBase: { namespace: 'organization', user_id: 1 },
        })
      ).toBe(false)
    })
  })

  describe('canManageKnowledgeBasePermissions', () => {
    it('allows creator', () => {
      expect(
        canManageKnowledgeBasePermissions({
          currentUserId: 1,
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
        })
      ).toBe(true)
    })

    it('allows namespace maintainer or owner', () => {
      expect(
        canManageKnowledgeBasePermissions({
          currentUserId: 2,
          namespaceRole: 'Maintainer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
        })
      ).toBe(true)
    })

    it('does not allow developer who did not create the knowledge base', () => {
      expect(
        canManageKnowledgeBasePermissions({
          currentUserId: 2,
          namespaceRole: 'Developer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
        })
      ).toBe(false)
    })
  })

  describe('canManageKnowledgeBaseDocuments', () => {
    it('allows namespace developer to upload documents to a shared namespace knowledge base', () => {
      expect(
        canManageKnowledgeBaseDocuments({
          currentUserId: 2,
          namespaceRole: 'Developer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
        })
      ).toBe(true)
    })

    it('allows explicit knowledge-base developer to upload documents', () => {
      expect(
        canManageKnowledgeBaseDocuments({
          currentUserId: 2,
          knowledgeRole: 'Developer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
        })
      ).toBe(true)
    })

    it('does not allow reporter to upload documents', () => {
      expect(
        canManageKnowledgeBaseDocuments({
          currentUserId: 2,
          namespaceRole: 'Reporter',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
        })
      ).toBe(false)
    })
  })

  describe('canManageKnowledgeDocument', () => {
    it('allows maintainer to manage any document in the knowledge base', () => {
      expect(
        canManageKnowledgeDocument({
          currentUserId: 2,
          namespaceRole: 'Maintainer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
          documentOwnerId: 1,
        })
      ).toBe(true)
    })

    it('allows developer to manage only their own document', () => {
      expect(
        canManageKnowledgeDocument({
          currentUserId: 2,
          namespaceRole: 'Developer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
          documentOwnerId: 2,
        })
      ).toBe(true)

      expect(
        canManageKnowledgeDocument({
          currentUserId: 2,
          namespaceRole: 'Developer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
          documentOwnerId: 1,
        })
      ).toBe(false)
    })

    it('allows knowledge-base manager when document owner is missing', () => {
      expect(
        canManageKnowledgeDocument({
          currentUserId: 2,
          knowledgeRole: 'Maintainer',
          knowledgeBase: { namespace: 'engineering', user_id: 1 },
          documentOwnerId: undefined,
        })
      ).toBe(true)
    })
  })

  describe('canManageNamespace', () => {
    it('allows only owner by default', () => {
      expect(canManageNamespace({ namespaceRole: 'Owner' })).toBe(true)
      expect(canManageNamespace({ namespaceRole: 'Maintainer' })).toBe(false)
    })

    it('does not allow namespace management without owner role', () => {
      expect(canManageNamespace({})).toBe(false)
    })
  })
})
