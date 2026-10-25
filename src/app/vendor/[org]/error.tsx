"use client";

import { SegmentError } from "@/components/app/segment-boundary";

/** Errors inside the vendor workspace render within its layout, so navigation stays available. */
export default function WorkspaceError({ error, retry, reset }: { error: unknown; retry?: () => void; reset?: () => void }) {
  return <SegmentError error={error} retry={retry ?? reset} base="vendor" />;
}
