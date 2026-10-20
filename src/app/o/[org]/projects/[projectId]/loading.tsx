import { PageSkeleton } from "@/components/app/page-skeleton";

// rendered below the project header and tabs, which stay on screen
export default function Loading() {
  return <PageSkeleton withHeader={false} />;
}
