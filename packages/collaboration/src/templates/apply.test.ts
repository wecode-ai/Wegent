import { expect, it, vi } from 'vitest'
import { applyTemplateGroups, PartialTemplateApplyError } from './apply'
import { bindTemplate } from './document'
import { builtinCollaborationTemplates } from './builtins'

it('distinguishes a first-operation failure from partial creation and stops further writes', async () => {
  const document = builtinCollaborationTemplates()[0].document
  const group = document.spec.resources.collaboration.groups[0]
  const roles = Object.fromEntries(
    group.roles.map(role => [
      role.key,
      {
        kind: 'human' as const,
        id: role.key === group.leaderRole ? '1' : '2',
        responsibility: '',
      },
    ])
  )
  const draft = bindTemplate(document, { [group.key]: roles })[0]
  const failure = new Error('Network unavailable')
  const create = vi.fn().mockRejectedValueOnce(failure)
  await expect(applyTemplateGroups([draft], create, 'Partial work')).rejects.toBe(failure)
  create.mockResolvedValueOnce({ id: 'one' }).mockRejectedValueOnce(failure)
  await expect(
    applyTemplateGroups([draft, draft, draft], create, 'Partial work')
  ).rejects.toBeInstanceOf(PartialTemplateApplyError)
  expect(create).toHaveBeenCalledTimes(3)
})
