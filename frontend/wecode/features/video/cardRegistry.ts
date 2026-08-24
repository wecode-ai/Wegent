// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { registerCardComponent } from '@/features/cards/registry'
import AigcVideoCard from './aigc_video/AigcVideoCard'

registerCardComponent('video_director_generation', AigcVideoCard)
