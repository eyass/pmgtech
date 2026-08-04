import { PageSkeleton } from '@/components/skeleton'

export default function Loading() {
  return <PageSkeleton title="Rankings" kpis={0} charts={4} table={false} />
}
