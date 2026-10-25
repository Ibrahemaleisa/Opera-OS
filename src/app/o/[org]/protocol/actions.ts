"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import { versionField } from "@/server/concurrency";
import * as pr from "@/server/modules/protocol/service";

const ok = () => null;

export const saveGuestAction = orgAction(pr.guestSchema, (ctx, i) => pr.saveGuest(ctx, i).then(ok));
export const importGuestsAction = orgAction(z.object({ projectId: z.string(), eventId: z.string().nullish() }), pr.importGuestsFromRecipients);
export const revealRestrictedAction = orgAction(z.object({ guestId: z.string() }), (ctx, i) => pr.revealRestrictedNotes(ctx, i.guestId));
export const setAttendanceAction = orgAction(z.object({ guestId: z.string(), attendance: z.enum(pr.ATTENDANCE), version: versionField }), pr.setAttendance);
export const saveZoneAction = orgAction(pr.zoneSchema, (ctx, i) => pr.saveZone(ctx, i).then(ok));
export const assignSeatAction = orgAction(z.object({ guestId: z.string(), seatZoneId: z.string().nullable(), seatLabel: z.string().trim().max(20).nullish(), version: versionField }), (ctx, i) => pr.assignSeat(ctx, i).then(ok));
export const saveAssignmentAction = orgAction(pr.assignmentSchema, (ctx, i) => pr.saveAssignment(ctx, i).then(ok));
