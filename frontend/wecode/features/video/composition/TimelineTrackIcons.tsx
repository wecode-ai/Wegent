// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Timeline track icons matching the video composition design spec
 * (一分钟创意视频-UI.pen): IconVideo (wlSCF), IconSubtitle (a7XG2U),
 * IconAudio (D8WaR).
 */
import React from 'react'

export interface TrackIconProps extends React.SVGProps<SVGSVGElement> {
  color?: string
}

export function IconVideo({ color = '#333333', width = 16, height = 16, ...rest }: TrackIconProps) {
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
      <g clipPath="url(#clip0_24_893)">
        {/* Video camera body */}
        <path
          d="M9.33315 4H2.66648C1.9301 4 1.33315 4.59695 1.33315 5.33333V10.6667C1.33315 11.403 1.9301 12 2.66648 12H9.33315C10.0695 12 10.6665 11.403 10.6665 10.6667V5.33333C10.6665 4.59695 10.0695 4 9.33315 4Z"
          stroke={color}
          strokeWidth="1.06667"
        />
        {/* Camera lens / viewfinder triangle */}
        <path
          d="M10.6664 6.66687L13.9998 4.66687V11.3335L10.6664 9.33354"
          stroke={color}
          strokeWidth="1.06667"
          strokeLinejoin="round"
        />
      </g>
      <defs>
        <clipPath id="clip0_24_893">
          <rect width="16" height="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  )
}

export function IconSubtitle({
  color = '#333333',
  width = 16,
  height = 16,
  ...rest
}: TrackIconProps) {
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
      <g clipPath="url(#clip0_24_875)">
        {/* Subtitle box */}
        <path
          d="M12.6667 3.33344H3.33333C2.59695 3.33344 2 3.93039 2 4.66677V11.3334C2 12.0698 2.59695 12.6668 3.33333 12.6668H12.6667C13.403 12.6668 14 12.0698 14 11.3334V4.66677C14 3.93039 13.403 3.33344 12.6667 3.33344Z"
          stroke={color}
          strokeWidth="1.06667"
        />
        {/* Caption lines */}
        <path
          d="M4 8H7.33333M8.66667 8H12M5.33333 10H10.6667"
          stroke={color}
          strokeWidth="0.933333"
          strokeLinecap="round"
        />
      </g>
      <defs>
        <clipPath id="clip0_24_875">
          <rect width="16" height="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  )
}

export function IconAudio({ color = '#333333', width = 16, height = 16, ...rest }: TrackIconProps) {
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
      {/* Music note stem */}
      <path
        d="M6.16574 11.3813V3.38131L12.8324 2.04797V10.048"
        stroke={color}
        strokeWidth="1.06667"
        strokeLinejoin="round"
      />
      {/* Bottom-left note head */}
      <path
        d="M4.66667 13.6668C5.58714 13.6668 6.33333 12.9206 6.33333 12.0001C6.33333 11.0796 5.58714 10.3334 4.66667 10.3334C3.74619 10.3334 3 11.0796 3 12.0001C3 12.9206 3.74619 13.6668 4.66667 13.6668Z"
        stroke={color}
        strokeWidth="1.06667"
      />
      {/* Bottom-right note head */}
      <path
        d="M11.3335 12.3333C12.254 12.3333 13.0002 11.5871 13.0002 10.6667C13.0002 9.74619 12.254 9 11.3335 9C10.413 9 9.66685 9.74619 9.66685 10.6667C9.66685 11.5871 10.413 12.3333 11.3335 12.3333Z"
        stroke={color}
        strokeWidth="1.06667"
      />
    </svg>
  )
}
