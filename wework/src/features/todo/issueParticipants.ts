import type { IssueResourceInvitation } from '@/api/personalIssues'

export interface IssueParticipant {
  key: string
  name: string
  kind: 'human' | 'agent' | 'group'
  id: number
}
export const participantKey = (person: { kind: string; id: number }) =>
  `${person.kind}:${person.id}`

export const resourceInvitations = (people: IssueParticipant[]): IssueResourceInvitation[] =>
  people
    .filter(
      (person): person is IssueParticipant & { kind: 'agent' | 'group' } => person.kind !== 'human'
    )
    .map(({ kind, id }) => ({ kind, id }))
