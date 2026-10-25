"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import { retryOutboxEvent } from "@/server/modules/recovery/service";

export const retryOutboxEventAction = orgAction(z.object({ eventId: z.string() }), (ctx, i) => retryOutboxEvent(ctx, i.eventId));
