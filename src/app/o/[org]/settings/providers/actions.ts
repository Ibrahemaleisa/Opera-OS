"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import { retryAllDead, retryDelivery } from "@/server/modules/notifications/delivery";

// orgAction kicks the dispatcher after the response, which sends what is now due
export const retryDeliveryAction = orgAction(z.object({ id: z.string() }), (ctx, i) => retryDelivery(ctx, i));
export const retryAllDeadAction = orgAction(z.object({}), (ctx) => retryAllDead(ctx));
