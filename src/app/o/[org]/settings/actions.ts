"use server";

import { z } from "zod";
import { orgAction } from "@/server/action";
import * as org from "@/server/modules/org/service";
import { clientSchema, contactSchema, customFieldSchema, inviteSchema, orgSettingsSchema, roleSchema, teamSchema, venueSchema } from "@/server/modules/org/schemas";

const id = z.object({ id: z.string().min(1) });

export const updateOrgAction = orgAction(orgSettingsSchema, org.updateOrganization);
export const inviteMemberAction = orgAction(inviteSchema, org.inviteMember);
export const revokeInvitationAction = orgAction(id, (ctx, i) => org.revokeInvitation(ctx, i.id));
export const changeRoleAction = orgAction(
  z.object({ membershipId: z.string(), roleId: z.string(), clientId: z.string().nullish(), vendorId: z.string().nullish() }),
  org.changeMemberRole,
);
export const setMemberStatusAction = orgAction(z.object({ membershipId: z.string(), status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]) }), org.setMemberStatus);
export const saveRoleAction = orgAction(roleSchema, org.saveRole);
export const saveClientAction = orgAction(clientSchema.extend({ id: z.string().optional() }), org.saveClient);
export const saveContactAction = orgAction(contactSchema.extend({ id: z.string().optional() }), org.saveContact);
export const saveVenueAction = orgAction(venueSchema.extend({ id: z.string().optional() }), org.saveVenue);
export const saveTeamAction = orgAction(teamSchema.extend({ id: z.string().optional() }), org.saveTeam);
export const saveCustomFieldAction = orgAction(customFieldSchema, org.saveCustomField);
export const archiveCustomFieldAction = orgAction(id, (ctx, i) => org.archiveCustomField(ctx, i.id));
