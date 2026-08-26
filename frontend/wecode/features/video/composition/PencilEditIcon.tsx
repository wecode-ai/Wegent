// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PencilEditIcon - hand-drawn pencil/edit icon matching the video composition
 * design spec (一分钟创意视频-UI.pen, node `cbGPS`).
 *
 * The design icon is a classic "edit-3" style glyph: a pencil tilted at 45°
 * (tip at the bottom-left, body extending to the top-right) with a short
 * horizontal writing line beneath the tip. Two stroked paths on a 16x16
 * viewBox, stroke #333333, thickness ~1.07.
 */
import React from 'react'

export interface PencilEditIconProps extends React.SVGProps<SVGSVGElement> {
  color?: string
}

export function PencilEditIcon({
  color = '#333333',
  width = 16,
  height = 16,
  ...rest
}: PencilEditIconProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      {/* Writing line beneath the pencil tip — matches design spec cbGPS. */}
      <path
        d="M1.66674 14.3333H13.6667"
        stroke={color}
        strokeWidth="1.07"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Pencil body: tip at bottom-left, body to top-right with a rounded shoulder. */}
      <path
        d="M2.8148 9.48144L2.07405 12.4444L5.03702 11.7037L12.1376 4.6031C12.7161 4.02454 12.7161 3.08652 12.1376 2.50796L12.0105 2.38088C11.4319 1.80232 10.4939 1.80232 9.9154 2.38088L2.8148 9.48144Z"
        stroke={color}
        strokeWidth="1.07"
        strokeLinejoin="round"
      />
    </svg>
  )
}
