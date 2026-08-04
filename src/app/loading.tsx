import { PageSkeleton } from '@/components/skeleton'

export default function Loading() {
  return <PageSkeleton title="Engineering overview" kpis={8} charts={4} table={true} />
}
