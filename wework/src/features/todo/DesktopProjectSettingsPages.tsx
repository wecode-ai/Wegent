// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Activity } from 'react'
import {
  RetainedProjectSettingsPages,
  type ProjectSettingsPagesProps,
} from '@wegent/collaboration/project-manage'

export function DesktopProjectSettingsPages(props: ProjectSettingsPagesProps) {
  return <RetainedProjectSettingsPages {...props} boundary={Activity} />
}
