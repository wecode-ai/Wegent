import type { IssueResourceInvitation } from './personalIssuesApi'

export interface IssueParticipant {
  key: string
  name: string
  needsIdentifier?: boolean
  kind: 'human' | 'agent' | 'group'
  id: number
}
export const participantKey = (person: { kind: string; id: number }) =>
  `${person.kind}:${person.id}`

export const participantNeedsIdentifier = (
  person: IssueParticipant,
  people: IssueParticipant[],
  selfId?: number
) =>
  !(person.kind === 'human' && person.id === selfId) &&
  (person.needsIdentifier ||
    people.some(
      other => other.key !== person.key && other.kind === person.kind && other.name === person.name
    ))

export const participantLabel = (
  person: IssueParticipant,
  people: IssueParticipant[],
  self?: { id: number; name: string }
) =>
  self && person.kind === 'human' && person.id === self.id
    ? self.name
    : participantNeedsIdentifier(person, people, self?.id)
      ? `${person.name} · #${person.id}`
      : person.name

export const resourceInvitations = (people: IssueParticipant[]): IssueResourceInvitation[] =>
  people
    .filter(
      (person): person is IssueParticipant & { kind: 'agent' | 'group' } => person.kind !== 'human'
    )
    .map(({ kind, id }) => ({ kind, id }))
