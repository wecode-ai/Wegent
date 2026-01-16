// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { authHandlers } from './user'
import { taskHandlers } from './tasks'
import { teamHandlers } from './team'
import { botHandlers } from './bot'
import { githubHandlers } from './github'

export const handlers = [
  ...authHandlers,
  ...taskHandlers,
  ...teamHandlers,
  ...botHandlers,
  ...githubHandlers,
  // Task list
]
