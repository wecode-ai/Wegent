// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { registerCardComponent } from '@/features/cards/registry'
import { registerTaskRightPanel } from '@/features/tasks/components/right-panel'
import AigcVideoCard from './aigc_video/AigcVideoCard'
import { AigcVideoPanel } from './aigc_video/AigcVideoPanel'

registerCardComponent('video_director_generation', AigcVideoCard)
registerCardComponent('video_short_generation', AigcVideoCard)
registerTaskRightPanel('aigc-video', AigcVideoPanel)
