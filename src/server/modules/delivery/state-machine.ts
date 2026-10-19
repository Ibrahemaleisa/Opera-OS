import type { DeliveryStatus } from "@/generated/prisma/enums";

/** Allowed delivery status transitions (office / dispatcher). */
export const TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  PENDING: ["VALIDATING", "READY", "CANCELLED"],
  VALIDATING: ["READY", "PENDING", "CANCELLED"],
  READY: ["ASSIGNED", "VALIDATING", "CANCELLED"],
  ASSIGNED: ["OUT_FOR_DELIVERY", "READY", "RESCHEDULED", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED_ATTEMPT", "RETURNED", "RESCHEDULED"],
  FAILED_ATTEMPT: ["OUT_FOR_DELIVERY", "RESCHEDULED", "RETURNED", "ASSIGNED", "READY", "CANCELLED"],
  RESCHEDULED: ["ASSIGNED", "OUT_FOR_DELIVERY", "READY", "CANCELLED"],
  RETURNED: ["READY", "ASSIGNED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: ["READY"],
};

/** Subset a field agent may perform on their own assigned deliveries. */
export const FIELD_TRANSITIONS: Partial<Record<DeliveryStatus, DeliveryStatus[]>> = {
  ASSIGNED: ["OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED_ATTEMPT", "RETURNED", "RESCHEDULED"],
  FAILED_ATTEMPT: ["OUT_FOR_DELIVERY", "RESCHEDULED", "RETURNED"],
  RESCHEDULED: ["OUT_FOR_DELIVERY"],
};

/** Statuses that count as an attempt outcome (create a DeliveryAttempt row). */
export const ATTEMPT_OUTCOMES: Partial<Record<DeliveryStatus, "DELIVERED" | "FAILED" | "RETURNED">> = {
  DELIVERED: "DELIVERED",
  FAILED_ATTEMPT: "FAILED",
  RETURNED: "RETURNED",
};

/** Field agents see contact data only while the delivery is actively theirs to deliver. */
export const ACTIVE_FIELD_STATUSES: DeliveryStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY", "FAILED_ATTEMPT", "RESCHEDULED"];

export const ASSIGNABLE: DeliveryStatus[] = ["READY", "FAILED_ATTEMPT", "RESCHEDULED", "RETURNED", "ASSIGNED"];

export function canTransition(from: DeliveryStatus, to: DeliveryStatus, field = false): boolean {
  const table = field ? FIELD_TRANSITIONS : TRANSITIONS;
  return (table[from] ?? []).includes(to);
}

export const FAILURE_REASONS = ["NO_ANSWER", "WRONG_ADDRESS", "RECIPIENT_UNAVAILABLE", "REFUSED", "ACCESS_DENIED", "SECURITY_CHECKPOINT", "OUTSIDE_WINDOW", "VEHICLE_ISSUE", "OTHER"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
