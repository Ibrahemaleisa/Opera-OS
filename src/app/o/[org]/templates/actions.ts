"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import * as templates from "@/server/modules/templates/service";

export const createTemplateAction = orgAction(
  z.object({ nameAr: z.string().trim().min(2).max(120), nameEn: z.string().trim().min(2).max(120), category: z.string().min(2).max(40), descriptionAr: z.string().max(500).nullish(), descriptionEn: z.string().max(500).nullish(), cloneFromId: z.string().nullish() }),
  (ctx, i) => templates.createTemplate(ctx, i).then((t) => ({ id: t.id })),
);
export const publishVersionAction = orgAction(z.object({ templateId: z.string(), definition: z.unknown(), changelog: z.string().max(500).nullish() }), (ctx, i) => templates.publishVersion(ctx, i.templateId, i.definition, i.changelog ?? undefined).then((v) => ({ version: v.version })));
export const archiveTemplateAction = orgAction(z.object({ id: z.string() }), (ctx, i) => templates.archiveTemplate(ctx, i.id));
