"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import { handoverSchema } from "@/server/modules/org/handover";
import { handoverPreview, setMemberStatus } from "@/server/modules/org/service";

/** The handover preview behind the dialog (BUSINESS_RULES §2, HO rule 1). */
export const handoverPreviewAction = orgAction(z.object({ membershipId: z.string() }), (ctx, i) => handoverPreview(ctx, i.membershipId));

/** Suspend or revoke with the handover, in one transaction with the status change (HO rule 1). */
export const departMemberAction = orgAction(
  z.object({ membershipId: z.string(), status: z.enum(["SUSPENDED", "REVOKED"]), handover: handoverSchema }),
  (ctx, i) => setMemberStatus(ctx, i),
);
