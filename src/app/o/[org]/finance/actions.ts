"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import * as fn from "@/server/modules/finance/service";

const ok = () => null;

export const saveBudgetAction = orgAction(fn.budgetSchema, (ctx, i) => fn.saveBudget(ctx, i).then(ok));
export const setContractValueAction = orgAction(z.object({ projectId: z.string(), contractValue: z.coerce.number().min(0).max(1e11).nullable() }), fn.setContractValue);
export const createPurchaseOrderAction = orgAction(fn.poSchema, (ctx, i) => fn.createPurchaseOrder(ctx, i).then(ok));
export const submitPurchaseOrderAction = orgAction(z.object({ id: z.string() }), (ctx, i) => fn.submitPurchaseOrder(ctx, i.id));
export const setPurchaseOrderStatusAction = orgAction(z.object({ id: z.string(), status: z.enum(["ISSUED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED", "CANCELLED"]) }), (ctx, i) => fn.setPurchaseOrderStatus(ctx, i));
export const createExpenseAction = orgAction(fn.expenseSchema, (ctx, i) => fn.createExpense(ctx, i).then((e) => ({ id: e.id })));
export const requestExpenseApprovalAction = orgAction(z.object({ id: z.string() }), (ctx, i) => fn.requestExpenseApproval(ctx, i.id).then(ok));
export const markExpensePaidAction = orgAction(z.object({ id: z.string() }), (ctx, i) => fn.markExpensePaid(ctx, i.id));
export const createChangeOrderAction = orgAction(fn.changeOrderSchema, (ctx, i) => fn.createChangeOrder(ctx, i).then(ok));
export const submitChangeOrderAction = orgAction(z.object({ id: z.string(), approverType: z.enum(["INTERNAL", "CLIENT"]) }), (ctx, i) => fn.submitChangeOrder(ctx, i).then(ok));
