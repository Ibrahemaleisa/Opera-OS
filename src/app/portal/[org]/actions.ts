"use server";

import { orgAction } from "@/server/action";
import { changeRequestSchema, changeResponseSchema, createChangeRequest, respondChangeRequest } from "@/server/modules/portal/service";

export const createChangeRequestAction = orgAction(changeRequestSchema, (ctx, i) => createChangeRequest(ctx, i).then(() => null));
export const respondChangeRequestAction = orgAction(changeResponseSchema, (ctx, i) => respondChangeRequest(ctx, i).then(() => null));
