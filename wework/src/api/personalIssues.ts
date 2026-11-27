import {
  createPersonalIssuesApi as createSharedPersonalIssuesApi,
  type PersonalIssuesApi as SharedPersonalIssuesApi,
} from '@wegent/collaboration/platform'
import type { CloudProject } from './deliveries'
import type { HttpClient } from './http'

export type {
  IndependentIssue,
  IndependentIssueInput,
  IssueCreationInput,
  IssueResourceInvitation,
  IssueResourceParticipant,
  PersonalIssueOrder,
  PersonalIssueScope,
  SharedIssueSource,
  SharedIssueTarget,
} from '@wegent/collaboration/platform'

export function createPersonalIssuesApi(client: HttpClient): PersonalIssuesApi {
  return createSharedPersonalIssuesApi<CloudProject>(client)
}

export type PersonalIssuesApi = SharedPersonalIssuesApi<CloudProject>
