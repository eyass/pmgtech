import { PageSkeleton } from '@/components/skeleton'

export default function Loading() {
  return <PageSkeleton title="Outliers" kpis={0} charts={3} table={true} />
}
