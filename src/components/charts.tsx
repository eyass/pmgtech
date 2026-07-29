'use client'

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { bucketLabel, squadColour } from '@/lib/format'
import type { SquadScorecard, TrendPoint } from '@/lib/types/metrics'

const AXIS = {
  stroke: 'var(--color-muted)',
  fontSize: 11,
}

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-surface)',
  border: '1px solid var(--color-line)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--color-ink)',
}

/** Reshape the long-format trend rows into one object per bucket. */
function pivot(
  points: TrendPoint[],
  metric: keyof Pick<TrendPoint, 'merged_mrs' | 'issues_resolved' | 'prod_deploys' | 'commits' | 'median_cycle_hours'>,
  bucket: 'day' | 'week' | 'month',
) {
  const byBucket = new Map<string, Record<string, string | number | null>>()
  for (const point of points) {
    const existing = byBucket.get(point.bucket) ?? { label: bucketLabel(point.bucket, bucket) }
    existing[point.squad_key] = point[metric]
    byBucket.set(point.bucket, existing)
  }
  return Array.from(byBucket.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row)
}

export function TrendChart({
  points,
  metric,
  bucket,
  squadKeys,
  stacked = false,
  height = 260,
}: {
  points: TrendPoint[]
  metric: 'merged_mrs' | 'issues_resolved' | 'prod_deploys' | 'commits' | 'median_cycle_hours'
  bucket: 'day' | 'week' | 'month'
  squadKeys: string[]
  stacked?: boolean
  height?: number
}) {
  const data = pivot(points, metric, bucket)

  if (data.length === 0) {
    return <ChartPlaceholder height={height} />
  }

  // Cycle time is a median, so stacking it would be meaningless — always lines.
  const asLines = metric === 'median_cycle_hours' || !stacked

  return (
    <ResponsiveContainer width="100%" height={height}>
      {asLines ? (
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--color-line)" vertical={false} />
          <XAxis dataKey="label" {...AXIS} tickLine={false} />
          <YAxis {...AXIS} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {squadKeys.map((key) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={squadColour(key)}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      ) : (
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--color-line)" vertical={false} />
          <XAxis dataKey="label" {...AXIS} tickLine={false} />
          <YAxis {...AXIS} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {squadKeys.map((key) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stackId="1"
              stroke={squadColour(key)}
              fill={squadColour(key)}
              fillOpacity={0.25}
            />
          ))}
        </AreaChart>
      )}
    </ResponsiveContainer>
  )
}

/** Single-series comparison across squads. */
export function SquadBarChart({
  squads,
  metric,
  height = 220,
}: {
  squads: SquadScorecard[]
  metric: keyof SquadScorecard
  height?: number
}) {
  const data = squads
    .map((s) => ({
      name: s.squad_name.replace(/^Team /, ''),
      key: s.squad_key,
      value: typeof s[metric] === 'number' ? (s[metric] as number) : 0,
    }))
    .filter((d) => d.value > 0)

  if (data.length === 0) return <ChartPlaceholder height={height} />

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="2 4" stroke="var(--color-line)" vertical={false} />
        <XAxis dataKey="name" {...AXIS} tickLine={false} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {data.map((d) => (
            <Cell key={d.key} fill={squadColour(d.key)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Sprint commitment vs delivery, oldest sprint on the left. */
export function SprintBarChart({
  sprints,
  height = 240,
}: {
  sprints: {
    sprint_name: string
    committed_issues: number
    added_issues: number
    completed_issues: number
  }[]
  height?: number
}) {
  const data = [...sprints].reverse().map((s) => ({
    name: s.sprint_name.length > 18 ? `${s.sprint_name.slice(0, 17)}…` : s.sprint_name,
    Committed: s.committed_issues,
    'Added mid-sprint': s.added_issues,
    Completed: s.completed_issues,
  }))

  if (data.length === 0) return <ChartPlaceholder height={height} />

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="2 4" stroke="var(--color-line)" vertical={false} />
        <XAxis dataKey="name" {...AXIS} tickLine={false} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="Committed" stackId="scope" fill="#94a3b8" radius={[0, 0, 0, 0]} />
        <Bar dataKey="Added mid-sprint" stackId="scope" fill="#d97706" radius={[4, 4, 0, 0]} />
        <Bar dataKey="Completed" fill="#059669" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function ChartPlaceholder({ height }: { height: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-[var(--color-line)] text-xs text-[var(--color-muted)]"
      style={{ height }}
    >
      No data in this period yet
    </div>
  )
}
