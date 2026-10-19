import { z } from "zod";

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "auth.agencySlugHint");

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().trim().toLowerCase().max(200),
  password: z.string().min(10).max(200),
  orgName: z.string().trim().min(2).max(160),
  orgSlug: slugSchema,
  locale: z.enum(["ar", "en"]).default("ar"),
});

export const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(200),
});

export const inviteSchema = z.object({
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().max(120).nullish(),
  roleId: z.string().min(1),
  clientId: z.string().optional().nullable(),
  vendorId: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(),
  projectRole: z.enum(["MANAGER", "LEAD", "MEMBER", "FREELANCER", "FIELD_AGENT", "CLIENT_VIEWER", "CLIENT_APPROVER", "VENDOR"]).optional().nullable(),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(10).max(200),
  name: z.string().trim().min(2).max(120).optional(),
  password: z.string().min(1).max(200),
});

export const orgSettingsSchema = z.object({
  name: z.string().trim().min(2).max(160),
  nameEn: z.string().trim().max(160).optional().nullable(),
  legalName: z.string().trim().max(200).optional().nullable(),
  crNumber: z.string().trim().max(20).optional().nullable(),
  vatNumber: z.string().trim().max(20).optional().nullable(),
  email: z.email().optional().nullable().or(z.literal("")),
  phone: z.string().trim().max(30).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  defaultLocale: z.enum(["ar", "en"]),
  calendar: z.enum(["gregory", "islamic-umalqura"]),
  financeApprovalThreshold: z.coerce.number().min(0).default(50000),
  recipientRetentionDays: z.coerce.number().int().min(30).max(3650).default(365),
});

export const clientSchema = z.object({
  name: z.string().trim().min(2).max(160),
  nameEn: z.string().trim().max(160).optional().nullable(),
  sector: z.string().trim().max(80).optional().nullable(),
  crNumber: z.string().trim().max(20).optional().nullable(),
  vatNumber: z.string().trim().max(20).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  website: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export const contactSchema = z.object({
  clientId: z.string().optional().nullable(),
  vendorId: z.string().optional().nullable(),
  name: z.string().trim().min(2).max(120),
  title: z.string().trim().max(120).optional().nullable(),
  email: z.email().optional().nullable().or(z.literal("")),
  phone: z.string().trim().max(30).optional().nullable(),
  isPrimary: z.boolean().default(false),
});

export const venueSchema = z.object({
  name: z.string().trim().min(2).max(160),
  nameEn: z.string().trim().max(160).optional().nullable(),
  city: z.string().trim().min(2).max(80),
  district: z.string().trim().max(80).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  mapsUrl: z.url().optional().nullable().or(z.literal("")),
  capacity: z.coerce.number().int().min(0).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export const roleSchema = z.object({
  id: z.string().optional(),
  nameAr: z.string().trim().min(2).max(80),
  nameEn: z.string().trim().min(2).max(80),
  baseRole: z.enum(["OWNER", "OPS_DIRECTOR", "PROJECT_MANAGER", "TEAM_LEAD", "EMPLOYEE", "FREELANCER", "FIELD_AGENT", "CLIENT", "CLIENT_APPROVER", "VENDOR"]),
  permissions: z.array(z.string()).max(200),
});

export const teamSchema = z.object({
  name: z.string().trim().min(2).max(120),
  nameEn: z.string().trim().max(120).optional().nullable(),
  leadId: z.string().optional().nullable(),
  memberIds: z.array(z.string()).default([]),
});

export const customFieldSchema = z.object({
  entityType: z.enum(["PROJECT", "TASK", "RECIPIENT", "GUEST", "VENDOR"]),
  key: z.string().regex(/^[a-z][a-zA-Z0-9_]{1,40}$/),
  labelAr: z.string().trim().min(1).max(80),
  labelEn: z.string().trim().min(1).max(80),
  fieldType: z.enum(["TEXT", "NUMBER", "DATE", "SELECT", "BOOLEAN"]),
  options: z.array(z.string().trim().min(1)).default([]),
  required: z.boolean().default(false),
});

export const emptyToNull = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === "" ? null : v])) as T;
