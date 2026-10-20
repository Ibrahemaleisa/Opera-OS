import { Skeleton } from "@/components/ui/skeleton";

/**
 * Instant placeholder shown while a server-rendered page streams in. Because it is a
 * `loading.tsx` boundary, Next.js prefetches it with every visible link, so navigation
 * responds on click even when the data takes a moment.
 */
export function PageSkeleton({ withHeader = true, rows = 6 }: { withHeader?: boolean; rows?: number }) {
  return (
    <div className="grid gap-5 px-4 py-6 md:px-6" aria-busy="true" aria-live="polite">
      {withHeader && (
        <div className="grid gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
      </div>
      <div className="grid gap-2 rounded-xl border bg-card p-4">
        {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9" />)}
      </div>
    </div>
  );
}
