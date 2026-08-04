import { PageSkeleton } from '@/components/skeleton'

export default function Loading() {
  return <PageSkeleton title="Squad" kpis={4} charts={3} table={true} />
}
