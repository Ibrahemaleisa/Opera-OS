import { z } from "zod";

const optDate = z.coerce.date().optional().nullable();
export const PROJECT_TYPES = ["CONFERENCE", "EVENT", "EXHIBITION", "VIP_DELIVERY", "PROTOCOL", "BOOTH", "PAVILION", "CUSTOM"] as const;

export const projectSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    nameEn: z.string().trim().max(200).optional().nullable(),
    description: z.string().trim().max(5000).optional().nullable(),
    clientId: z.string().optional().nullable(),
    type: z.enum(PROJECT_TYPES).default("CONFERENCE"),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
    contractRef: z.string().trim().max(100).optional().nullable(),
    poReference: z.string().trim().max(100).optional().nullable(),
    budgetAmount: z.coerce.number().min(0).max(1e12).optional().nullable(),
    currency: z.string().length(3).default("SAR"),
    startDate: optDate,
    deadline: optDate,
    eventStartAt: optDate,
    eventEndAt: optDate,
    venueIds: z.array(z.string()).default([]),
    managerId: z.string().optional().nullable(),
    clientPortal: z.boolean().default(true),
    /** the version the user loaded (BUSINESS_RULES §6); required on update, ignored on create */
    version: z.number().int().optional(),
  })
  .refine((p) => !p.startDate || !p.deadline || p.deadline >= p.startDate, { path: ["deadline"], message: "errors.validation" })
  .refine((p) => !p.eventStartAt || !p.eventEndAt || p.eventEndAt >= p.eventStartAt, { path: ["eventEndAt"], message: "errors.validation" });

export const createProjectSchema = projectSchema.and(z.object({ templateIds: z.array(z.string()).max(10).default([]) }));

export const memberSchema = z.object({
  projectId: z.string(),
  userId: z.string(),
  role: z.enum(["MANAGER", "LEAD", "MEMBER", "FREELANCER", "FIELD_AGENT", "CLIENT_VIEWER", "CLIENT_APPROVER", "VENDOR"]),
  canViewFinance: z.boolean().default(false),
  canViewVip: z.boolean().default(false),
  canExport: z.boolean().default(false),
  canApprove: z.boolean().default(false),
  workstreamIds: z.array(z.string()).default([]),
});

export const milestoneSchema = z.object({
  id: z.string().optional(),
  projectId: z.string(),
  title: z.string().trim().min(2).max(200),
  dueDate: optDate,
  status: z.enum(["PENDING", "IN_PROGRESS", "BLOCKED", "DONE"]).default("PENDING"),
  clientVisible: z.boolean().default(true),
  workstreamId: z.string().optional().nullable(),
  version: z.number().int().optional(),
});

export const riskSchema = z.object({
  id: z.string().optional(),
  projectId: z.string(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  likelihood: z.coerce.number().int().min(1).max(5),
  impact: z.coerce.number().int().min(1).max(5),
  status: z.enum(["OPEN", "MITIGATING", "CLOSED"]).default("OPEN"),
  ownerId: z.string().optional().nullable(),
  mitigation: z.string().trim().max(2000).optional().nullable(),
  version: z.number().int().optional(),
});

export const deliverableSchema = z.object({
  id: z.string().optional(),
  projectId: z.string(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  status: z.enum(["PENDING", "IN_PROGRESS", "SUBMITTED", "APPROVED", "REJECTED"]).default("PENDING"),
  dueDate: optDate,
  clientVisible: z.boolean().default(true),
  requiresApproval: z.boolean().default(false),
  workstreamId: z.string().optional().nullable(),
  version: z.number().int().optional(),
});

export const independentApprovalSchema = z.object({ projectId: z.string(), value: z.boolean(), version: z.number().int().optional(), reason: z.string().trim().max(1000).optional().nullable() });
