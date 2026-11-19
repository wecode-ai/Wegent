// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function GroupConfigurationError({ message }: { message: string | null }) {
  return message ? (
    <div className="collaboration-alert" role="alert">
      {message}
    </div>
  ) : null
}
