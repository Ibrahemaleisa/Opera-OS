"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import * as ev from "@/server/modules/events/service";

const ok = () => null;

export const createEventAction = orgAction(z.object({ projectId: z.string(), name: z.string().trim().min(2).max(200), startsAt: z.coerce.date(), endsAt: z.coerce.date() }), (ctx, i) => ev.createEvent(ctx, i).then((e) => ({ id: e.id })));
export const updateEventAction = orgAction(ev.eventSchema, (ctx, i) => ev.updateEvent(ctx, i).then(ok));
export const saveSessionAction = orgAction(ev.sessionSchema, (ctx, i) => ev.saveSession(ctx, i).then(ok));
export const deleteSessionAction = orgAction(z.object({ id: z.string(), eventId: z.string() }), (ctx, i) => ev.deleteSession(ctx, i).then(ok));
export const saveSpeakerAction = orgAction(ev.speakerSchema, (ctx, i) => ev.saveSpeaker(ctx, i).then(ok));
export const saveRunItemAction = orgAction(ev.runItemSchema, (ctx, i) => ev.saveRunItem(ctx, i).then(ok));
export const setRunItemStatusAction = orgAction(z.object({ id: z.string(), status: z.enum(ev.RUN_STATUSES), expected: z.string().optional() }), ev.setRunItemStatus);
export const saveShiftAction = orgAction(ev.shiftSchema, (ctx, i) => ev.saveShift(ctx, i).then(ok));
export const setShiftStatusAction = orgAction(z.object({ id: z.string(), status: z.enum(["SCHEDULED", "CHECKED_IN", "COMPLETED", "NO_SHOW"]) }), (ctx, i) => ev.setShiftStatus(ctx, i).then(ok));
export const saveReadinessAction = orgAction(ev.readinessSchema, (ctx, i) => ev.saveReadiness(ctx, i).then(ok));
export const setReadinessStatusAction = orgAction(z.object({ id: z.string(), status: z.enum(["PENDING", "IN_PROGRESS", "READY", "ISSUE"]), note: z.string().trim().max(1000).nullish() }), (ctx, i) => ev.setReadinessStatus(ctx, i).then(ok));
export const reportIncidentAction = orgAction(ev.incidentSchema, (ctx, i) => ev.reportIncident(ctx, i).then((x) => ({ id: x.id })));
export const updateIncidentAction = orgAction(ev.incidentUpdateSchema, (ctx, i) => ev.updateIncident(ctx, i).then(ok));
export const saveLogisticsAction = orgAction(ev.logisticsSchema, (ctx, i) => ev.saveLogistics(ctx, i).then(ok));
