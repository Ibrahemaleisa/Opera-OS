"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import * as d from "@/server/modules/delivery/service";
import * as imp from "@/server/modules/delivery/imports/service";

export const saveCampaignAction = orgAction(d.campaignSchema, (ctx, i) => d.saveCampaign(ctx, i).then((c) => ({ id: c.id })));
export const generateDeliveriesAction = orgAction(z.object({ campaignId: z.string(), recipientIds: z.array(z.string()).min(1).max(5000) }), d.generateDeliveries);
export const bulkAssignAction = orgAction(d.assignSchema, d.bulkAssign);
export const createBatchAction = orgAction(d.batchSchema, (ctx, i) => d.createBatch(ctx, i).then((b) => ({ id: b.id, code: b.code })));
export const updateStatusAction = orgAction(d.statusSchema, (ctx, i) => d.updateDeliveryStatus(ctx, i).then((r) => ({ status: r.delivery.status, version: r.delivery.version })));
export const escalateAction = orgAction(z.object({ deliveryId: z.string(), note: z.string().trim().min(3).max(1000) }), d.escalateDelivery);
export const revealRecipientAction = orgAction(z.object({ recipientId: z.string() }), (ctx, i) => d.revealRecipient(ctx, i.recipientId));
export const updateRecipientAction = orgAction(d.recipientPatchSchema, (ctx, i) => d.updateRecipient(ctx, i).then(() => null));
export const anonymizeAction = orgAction(z.object({ projectId: z.string(), recipientIds: z.array(z.string()).optional(), expiredOnly: z.boolean().optional() }), d.anonymizeRecipients);

export const importPreviewAction = orgAction(z.object({ batchId: z.string(), sheetName: z.string().optional(), headerRow: z.number().int().min(1).max(50).optional() }), (ctx, i) => imp.getImportPreview(ctx, i.batchId, i.sheetName || i.headerRow ? { sheetName: i.sheetName, headerRow: i.headerRow } : undefined));
export const configureImportAction = orgAction(imp.configureSchema, imp.configureAndValidate);
export const updateImportRowAction = orgAction(z.object({ batchId: z.string(), rowId: z.string(), overrides: z.record(z.string(), z.string().nullable()) }), (ctx, i) => imp.updateImportRow(ctx, i as never).then((r) => ({ status: r.status })));
export const resolveImportRowsAction = orgAction(z.object({ batchId: z.string(), rowIds: z.array(z.string()).optional(), scope: z.enum(["ALL_DUPLICATES", "ALL_INVALID"]).optional(), resolution: z.enum(["SKIP", "IMPORT_AS_NEW", "LINK_EXISTING", "PENDING"]) }), imp.resolveRows);
export const commitImportAction = orgAction(imp.commitSchema, imp.commitImport);
export const rollbackImportAction = orgAction(z.object({ batchId: z.string() }), (ctx, i) => imp.rollbackImport(ctx, i.batchId));
export const resumeImportAction = orgAction(z.object({ batchId: z.string() }), (ctx, i) => imp.resumeImport(ctx, i.batchId));
export const importStatusAction = orgAction(z.object({ batchId: z.string() }), (ctx, i) => imp.importStatus(ctx, i.batchId));
