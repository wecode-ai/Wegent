'use client'

import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Legend,
  Tooltip,
  Sector,
} from 'recharts'
import { useState, useCallback } from 'react'

interface PieChartData {
  name: string
  value: number
  percentage: number
  issueType?: string // Original issue type key for filtering
}

interface IssuePieChartProps {
  data: PieChartData[]
  onSliceClick?: (issueType: string | null, name: string | null) => void
  selectedIssueType?: string | null
}

const COLORS = [
  '#EF4444',
  '#F59E0B',
  '#10B981',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
]

// Custom active shape for selected slice
const renderActiveShape = (props: any) => {
  const {
    cx,
    cy,
    innerRadius,
    outerRadius,
    startAngle,
    endAngle,
    fill,
    payload,
    percent,
  } = props

  return (
    <g>
      <Sector
        cx={cx}
        cy={cy}
        innerRadius={innerRadius}
        outerRadius={outerRadius + 10}
        startAngle={startAngle}
        endAngle={endAngle}
        fill={fill}
        stroke="#fff"
        strokeWidth={2}
      />
      <text
        x={cx}
        y={cy - 10}
        textAnchor="middle"
        fill="#333"
        className="text-sm font-medium"
      >
        {payload.name}
      </text>
      <text
        x={cx}
        y={cy + 10}
        textAnchor="middle"
        fill="#666"
        className="text-xs"
      >
        {`${payload.value} (${(percent * 100).toFixed(1)}%)`}
      </text>
    </g>
  )
}

export function IssuePieChart({
  data,
  onSliceClick,
  selectedIssueType,
}: IssuePieChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined)

  // Find active index based on selected issue type
  const getActiveIndex = useCallback(() => {
    if (!selectedIssueType) return undefined
    const index = data.findIndex((item) => item.issueType === selectedIssueType)
    return index >= 0 ? index : undefined
  }, [data, selectedIssueType])

  const handleClick = useCallback(
    (data: any, index: number) => {
      if (onSliceClick) {
        const clickedIssueType = data.issueType || null
        const clickedName = data.name || null
        // Toggle selection: if clicking the same slice, deselect it
        if (selectedIssueType === clickedIssueType) {
          onSliceClick(null, null)
        } else {
          onSliceClick(clickedIssueType, clickedName)
        }
      }
    },
    [onSliceClick, selectedIssueType]
  )

  const handleMouseEnter = useCallback((_: any, index: number) => {
    setActiveIndex(index)
  }, [])

  const handleMouseLeave = useCallback(() => {
    setActiveIndex(undefined)
  }, [])

  const currentActiveIndex = getActiveIndex() ?? activeIndex

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            labelLine={false}
            outerRadius={100}
            fill="#8884d8"
            dataKey="value"
            activeIndex={currentActiveIndex}
            activeShape={renderActiveShape}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={handleClick}
            label={({ name, percentage }) =>
              `${name}: ${(percentage * 100).toFixed(1)}%`
            }
            style={{ cursor: onSliceClick ? 'pointer' : 'default' }}
          >
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={COLORS[index % COLORS.length]}
                opacity={
                  selectedIssueType && entry.issueType !== selectedIssueType
                    ? 0.4
                    : 1
                }
                style={{ cursor: onSliceClick ? 'pointer' : 'default' }}
              />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: number, name: string, props: any) => [
              `${value} (${(props.payload.percentage * 100).toFixed(1)}%)`,
              name,
            ]}
          />
          <Legend
            onClick={(e: any) => {
              if (onSliceClick && e && e.payload) {
                const clickedIssueType = e.payload.issueType || null
                const clickedName = e.payload.name || null
                if (selectedIssueType === clickedIssueType) {
                  onSliceClick(null, null)
                } else {
                  onSliceClick(clickedIssueType, clickedName)
                }
              }
            }}
            wrapperStyle={{ cursor: onSliceClick ? 'pointer' : 'default' }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
