"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import { BUDGET_CATEGORIES } from "@/server/modules/finance/codes";
import * as vd from "@/server/modules/vendors/service";

const ok = () => null;

export const saveVendorAction = orgAction(vd.vendorSchema, (ctx, i) => vd.saveVendor(ctx, i).then(ok));
export const createRfqAction = orgAction(vd.rfqSchema, (ctx, i) => vd.createRfq(ctx, i).then(ok));
export const recordQuoteAction = orgAction(vd.quoteSchema, (ctx, i) => vd.recordQuote(ctx, i).then(ok));
export const awardQuoteAction = orgAction(z.object({ quoteId: z.string(), budgetCategory: z.enum(BUDGET_CATEGORIES), justification: z.string().trim().max(1000).nullish() }), vd.awardQuote);
export const createWorkOrderAction = orgAction(vd.workOrderSchema, (ctx, i) => vd.createWorkOrder(ctx, i).then(ok));
export const setWorkOrderStatusAction = orgAction(z.object({ id: z.string(), status: z.enum(vd.WO_STATUSES), rating: z.coerce.number().int().min(1).max(5).nullish() }), (ctx, i) => vd.setWorkOrderStatus(ctx, i).then(ok));
