"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import * as bt from "@/server/modules/booths/service";

const ok = () => null;

export const saveBoothAction = orgAction(bt.boothSchema, (ctx, i) => bt.saveBooth(ctx, i).then((b) => ({ id: b.id })));
export const setBoothStageAction = orgAction(z.object({ boothId: z.string(), stage: z.enum(bt.STAGES as [string, ...string[]]), reason: z.string().trim().max(500).nullish() }), (ctx, i) => bt.setBoothStage(ctx, i as never).then(ok));
export const createRevisionAction = orgAction(z.object({ boothId: z.string(), title: z.string().trim().min(2).max(200), notes: z.string().trim().max(2000).nullish() }), (ctx, i) => bt.createRevision(ctx, i).then(ok));
export const submitRevisionAction = orgAction(z.object({ revisionId: z.string(), approverType: z.enum(["INTERNAL", "CLIENT"]), approverUserId: z.string().nullish() }), (ctx, i) => bt.submitRevision(ctx, i).then(ok));
export const saveBoqItemAction = orgAction(bt.boqSchema, (ctx, i) => bt.saveBoqItem(ctx, i).then(ok));
export const deleteBoqItemAction = orgAction(z.object({ id: z.string(), boothId: z.string() }), (ctx, i) => bt.deleteBoqItem(ctx, i).then(ok));
export const recordInspectionAction = orgAction(bt.inspectionSchema, (ctx, i) => bt.recordInspection(ctx, i).then(ok));
export const saveSnagAction = orgAction(bt.snagSchema, (ctx, i) => bt.saveSnag(ctx, i).then(ok));
export const setSnagStatusAction = orgAction(z.object({ id: z.string(), status: z.enum(["OPEN", "IN_PROGRESS", "FIXED", "VERIFIED"]) }), (ctx, i) => bt.setSnagStatus(ctx, i).then(ok));
export const signHandoverAction = orgAction(z.object({ boothId: z.string(), signedBy: z.string().trim().min(2).max(200) }), (ctx, i) => bt.signHandover(ctx, i).then(ok));
