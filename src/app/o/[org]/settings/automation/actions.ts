"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import { setRuleEnabled } from "@/server/modules/automation/admin";

export const setRuleEnabledAction = orgAction(z.object({ id: z.string(), enabled: z.boolean() }), setRuleEnabled);
