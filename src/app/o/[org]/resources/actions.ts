"use server";

import { orgAction } from "@/server/action";
import { profileSchema, saveResourceProfile } from "@/server/modules/resources/service";

export const saveResourceProfileAction = orgAction(profileSchema, (ctx, i) => saveResourceProfile(ctx, i).then(() => null));
