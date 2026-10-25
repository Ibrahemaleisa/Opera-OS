"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import * as dg from "@/server/modules/digital/service";
import { applyProviderEvent } from "@/server/modules/digital/sender";
import { assertCan } from "@/server/authz/policy";
import { withTenant } from "@/server/db/tenant";
import { NotFoundError } from "@/server/errors";

// approvalInvalidated: the edit voided a pending/given approval and returned the campaign to DRAFT (UI should say so)
export const saveDigitalCampaignAction = orgAction(dg.digitalCampaignSchema, (ctx, i) => dg.saveDigitalCampaign(ctx, i).then((c) => ({ id: c.id, approvalInvalidated: "approvalInvalidated" in c ? c.approvalInvalidated : false })));
export const addAudienceAction = orgAction(z.object({ campaignId: z.string(), recipientIds: z.array(z.string()).min(1).max(5000) }), dg.addAudience);
export const removeAudienceAction = orgAction(z.object({ campaignId: z.string(), invitationIds: z.array(z.string()).min(1) }), dg.removeAudience);
export const requestCampaignApprovalAction = orgAction(z.object({ campaignId: z.string() }), (ctx, i) => dg.requestCampaignApproval(ctx, i.campaignId).then(() => null));
export const launchCampaignAction = orgAction(z.object({ campaignId: z.string() }), (ctx, i) => dg.launchCampaign(ctx, i.campaignId));
export const cancelCampaignAction = orgAction(z.object({ campaignId: z.string() }), (ctx, i) => dg.cancelCampaign(ctx, i.campaignId));
export const checkInAction = orgAction(z.object({ campaignId: z.string(), code: z.string().trim().min(4).max(40) }), dg.checkIn);
export const setProviderModeAction = orgAction(z.object({ channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]), mode: z.enum(["SIMULATION", "LIVE"]), senderId: z.string().max(40).nullish() }), dg.setProviderMode);

/** Simulation-only helper: produces a delivery receipt for a simulated message (clearly labelled in UI). */
export const simulateReceiptAction = orgAction(z.object({ invitationId: z.string(), status: z.enum(["DELIVERED", "READ", "FAILED"]) }), async (ctx, i) => {
  assertCan(ctx, "campaign.manage");
  const job = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => tx.messageJob.findFirst({ where: { invitationId: i.invitationId, simulated: true, providerMessageId: { not: null } }, orderBy: { createdAt: "desc" } }));
  if (!job?.providerMessageId) throw new NotFoundError();
  return applyProviderEvent("simulation", { externalId: `ui-${job.id}-${i.status}-${Date.now()}`, providerMessageId: job.providerMessageId, status: i.status }, { source: "ui-simulation", by: ctx.userId });
});
