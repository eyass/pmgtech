import { PageSkeleton } from '@/components/skeleton'

export default function Loading() {
  return <PageSkeleton title="Admin" kpis={0} charts={0} table={true} />
}
