// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { GroupConfigurationView } from './GroupConfigurationView'
import { useGroupConfiguration } from './useGroupConfiguration'
export type {
  GroupConfigurationModel,
  WorkspaceResourceCommands,
  CollaborationGroupAgentActions,
} from './useGroupConfiguration'

export function WorkspaceCollaborationGroupsConfiguration(
  props: Parameters<typeof useGroupConfiguration>[0]
) {
  const model = useGroupConfiguration(props)
  return <GroupConfigurationView model={model} />
}
