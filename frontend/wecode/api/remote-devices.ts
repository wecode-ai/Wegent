// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import type {
  CreateDockerRemoteDeviceCommandRequest,
  DockerRemoteDeviceCommandResponse,
} from '@wecode/types/remote-devices'

export async function createDockerRemoteDeviceCommand(
  request: CreateDockerRemoteDeviceCommandRequest = {}
): Promise<DockerRemoteDeviceCommandResponse> {
  return apiClient.post('/remote-devices/docker/start-command', request)
}
