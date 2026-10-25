"use client";

import { RotateCcw } from "lucide-react";
import { ActionButton } from "@/components/app/action-button";
import { useAction } from "@/hooks/use-action";
import { useI18n } from "@/lib/i18n/client";
import { retryOutboxEventAction } from "./actions";

/** §7.3: puts a dead outbox event back in the dispatcher's queue (audited `system.outbox_retry`). */
export function RetryOutboxButton({ orgSlug, eventId }: { orgSlug: string; eventId: string }) {
  const { m } = useI18n();
  const retry = useAction(retryOutboxEventAction, { orgSlug, success: m.health.outbox.retried });
  return (
    <ActionButton size="xs" variant="outline" action={() => retry.run({ eventId })} data-testid={`outbox-retry-${eventId}`}>
      <RotateCcw /> {m.health.outbox.retry}
    </ActionButton>
  );
}
