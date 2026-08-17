// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface CreateDockerRemoteDeviceCommandRequest {
  container_name?: string
  client_origin?: string
}

export interface RemoteDeviceStartupCommand {
  kind: 'docker' | 'process' | string
  label: string
  description?: string | null
  command: string
}

export interface DockerRemoteDeviceCommandResponse {
  device_id: string
  name: string
  image: string
  env: Record<string, string>
  command: string
  commands: RemoteDeviceStartupCommand[]
}
