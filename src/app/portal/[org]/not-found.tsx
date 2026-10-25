import { SegmentNotFound } from "@/components/app/segment-boundary";

/** notFound() inside the portal workspace keeps the shell around the 404. */
export default function WorkspaceNotFound() {
  return <SegmentNotFound base="portal" />;
}
