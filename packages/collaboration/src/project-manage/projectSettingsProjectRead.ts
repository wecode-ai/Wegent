// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ProjectSettingsSectionId } from "../types";

// Project-version editors need current metadata before mounting. Other pages
// own their resource reads, including configuration sharing's project snapshot.
export const projectSettingsProjectRead: Record<
  ProjectSettingsSectionId,
  "cached" | "current"
> = {
  project: "current",
  members: "current",
  environments: "current",
  agents: "cached",
  groups: "cached",
  "automatic-processing": "cached",
  "configuration-sharing": "cached",
};
