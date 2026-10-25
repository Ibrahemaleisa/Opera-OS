import ExcelJS from "exceljs";
import { z } from "zod";
import type { ImportRowStatus, Prisma } from "@/generated/prisma/client";
import { addXlsxRow } from "../export";
import { createId, shortCode } from "@/lib/id";
import { systemContext, type ServiceContext } from "@/server/authz/context";
import { assertCan, assertNotArchived, projectScope } from "@/server/authz/policy";
import { withTenant, type Tx } from "@/server/db/tenant";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { audit } from "@/server/modules/audit/audit";
import { emit } from "@/server/modules/automation/outbox";
import { notify } from "@/server/modules/notifications/notify";
import { storeAttachment } from "@/server/modules/files/service";
import { storage } from "@/server/modules/files/storage";
import { enqueue } from "@/server/jobs/dispatch";
import { CANONICAL_FIELDS, headerSignature, suggestMapping } from "./canonical";
import { DEFAULT_OPTIONS, nameKey, normalizeRow, type ImportOptions, type Mapping, type NormalizedRecipient } from "./normalize";
import { assertRowCap, extractTable, parseWorkbook, pickSheet } from "./parse";

/** Imports up to this many rows are processed within the request; larger ones go to the worker. */
export const INLINE_ROW_LIMIT = Number(process.env.IMPORT_INLINE_ROW_LIMIT ?? 1500);
const CHUNK = 300;

// ── Processing lease (BUSINESS_RULES §7.1) ──────────────────────────────────

/** A run holds the batch for 120 s and renews after every chunk (≤ 1000 rows) and at least every 60 s. */
export const IMPORT_LEASE_MS = 120_000;
/** Attempts per stage (the user's start counts as the first); then the sweep gives up. */
export const IMPORT_MAX_ATTEMPTS = 3;

/** Thrown inside a run that lost its lease (another run resumed the batch): the run stops quietly. */
class LeaseLost extends Error {}

const leaseEnd = (from = Date.now()) => new Date(from + IMPORT_LEASE_MS);
const leaseToken = (kind: "req" | "run" | "resume") => `${kind}:${createId()}`;

/**
 * Starts a run: takes the lease over from `expected` (the request or resume that started it; a job
 * without one adopts the current holder) under a fresh token, so two runs never hold it together.
 */
async function takeImportLease(orgId: string, batchId: string, status: "VALIDATING" | "COMMITTING", expected?: string): Promise<string | null> {
  return withTenant({ orgId }, async (tx) => {
    const b = await tx.importBatch.findUnique({ where: { id: batchId }, select: { status: true, leaseOwner: true } });
    if (!b || b.status !== status) return null;
    const token = leaseToken("run");
    const r = await tx.importBatch.updateMany({ where: { id: batchId, status, leaseOwner: expected === undefined ? b.leaseOwner : expected }, data: { leaseOwner: token, leaseUntil: leaseEnd() } });
    return r.count ? token : null;
  });
}

/** Renews the lease inside the caller's transaction; throws {@link LeaseLost} when another run took over. */
async function renewImportLease(tx: Tx, batchId: string, status: "VALIDATING" | "COMMITTING", token: string) {
  const r = await tx.importBatch.updateMany({ where: { id: batchId, status, leaseOwner: token }, data: { leaseUntil: leaseEnd() } });
  if (!r.count) throw new LeaseLost();
}

export const optionsSchema = z.object({
  duplicateScope: z.enum(["PROJECT", "ORGANIZATION"]).default("PROJECT"),
  matchOn: z.array(z.enum(["mobile", "email", "externalRef", "name"])).min(1).default(["mobile", "externalRef", "name"]),
  requireMobile: z.boolean().default(true),
  requireLocation: z.boolean().default(true),
  defaultCity: z.string().trim().max(80).nullish(),
});

function readOptions(raw: unknown): ImportOptions {
  const p = optionsSchema.safeParse(raw ?? {});
  return p.success ? { ...DEFAULT_OPTIONS, ...p.data, defaultCity: p.data.defaultCity ?? null } : DEFAULT_OPTIONS;
}

/** Loads a batch for reading (also in archived projects, LC rule 5) or for a change ("write"). */
async function loadBatch(tx: Tx, ctx: ServiceContext, batchId: string, mode: "read" | "write" = "write") {
  const batch = await tx.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new NotFoundError();
  const scope = await projectScope(tx, ctx, batch.projectId);
  if (mode === "write") assertNotArchived(scope);
  if (!(mode === "read" && scope.archived ? scope.tailOperate : scope.operate) || scope.clientView) throw new ForbiddenError();
  assertCan(ctx, "recipient.import");
  return { batch, scope };
}

async function readTable(batch: { storageKey: string; fileName: string; sheetName: string | null; headerRow: number }) {
  const buf = await storage().get(batch.storageKey);
  const sheets = await parseWorkbook(buf, batch.fileName);
  const sheet = sheets.find((s) => s.name === batch.sheetName) ?? sheets[0];
  if (!sheet) throw new ValidationError("errors.fileType");
  return { sheets, sheet, ...extractTable(sheet.grid, batch.headerRow) };
}

// ── Masking (import review without VIP scope) ───────────────────────────────

const SENSITIVE_FIELDS = new Set(["mobile", "mobileRaw", "altPhone", "email", "address", "mapsUrl", "lat", "lng", "deliveryInstructions"]);
/** Any run of 7+ digits (phones written with spaces/dashes included). */
const DIGIT_RUN = /\+?\d[\d\s\-().]{5,}\d/g;

function maskText(v: unknown): unknown {
  if (typeof v === "number") return String(Math.trunc(v)).length >= 7 ? "•••" : v;
  if (typeof v !== "string") return v;
  return v.replace(DIGIT_RUN, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 7 ? `•••${d.slice(-4)}` : m;
  });
}

function maskNormalizedRow(n: unknown): unknown {
  if (!n || typeof n !== "object") return n;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
    if (k === "custom" && v && typeof v === "object") out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([ck, cv]) => [ck, maskText(cv)]));
    else out[k] = SENSITIVE_FIELDS.has(k) ? (v == null || v === "" ? v : k === "lat" || k === "lng" || k === "mapsUrl" ? null : maskText(k === "address" || k === "deliveryInstructions" ? "•••" : v)) : maskText(v);
  }
  return out;
}

/** Raw sheet cells: columns mapped to contact fields are blanked, any other phone-like value is masked. */
function maskRawRow(raw: unknown, mapping: Mapping): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const sensitiveHeaders = new Set(Object.entries(mapping ?? {}).filter(([field]) => SENSITIVE_FIELDS.has(field)).map(([, header]) => header));
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([h, v]) => [h, sensitiveHeaders.has(h) && v != null && v !== "" ? "•••" : maskText(v)]));
}

// ── 1. Upload ───────────────────────────────────────────────────────────────

export async function createImport(ctx: ServiceContext, input: { projectId: string; campaignId?: string | null; fileName: string; declaredType: string; body: Buffer }) {
  assertCan(ctx, "recipient.import");
  const ext = input.fileName.toLowerCase().split(".").pop();
  if (!["xlsx", "csv"].includes(ext ?? "")) throw new ValidationError("errors.fileType");
  assertRowCap(input.body, input.fileName); // §7.1 rule 4: refused before any row is parsed
  const sheets = await parseWorkbook(input.body, input.fileName); // validate before storing
  if (!sheets.length || sheets.every((s) => s.grid.length < 2)) throw new ValidationError("errors.noRowsSelected");
  // KD-2: the sheet with the best header score, not merely the first one
  const { sheet: first, headerRow } = pickSheet(sheets)!;
  const { headers, rows } = extractTable(first.grid, headerRow);
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const scope = await projectScope(tx, ctx, input.projectId);
    assertNotArchived(scope);
    if (!scope.operate || scope.clientView) throw new ForbiddenError();
    if (input.campaignId && !(await tx.invitationCampaign.findFirst({ where: { id: input.campaignId, projectId: input.projectId, type: "PHYSICAL" } }))) throw new NotFoundError();
    const batchId = createId();
    const att = await storeAttachment(tx, ctx, { projectId: input.projectId, entityType: "IMPORT", entityId: batchId, kind: "FILE", fileName: input.fileName, declaredType: input.declaredType, body: input.body });
    const saved = await tx.importMapping.findFirst({ where: { kind: "RECIPIENTS", headerSignature: headerSignature(headers) }, orderBy: { createdAt: "desc" } });
    const previous = await tx.importBatch.findFirst({ where: { projectId: input.projectId, fileSha256: att.sha256, status: { in: ["COMMITTED", "PARTIALLY_COMMITTED"] } }, select: { id: true, createdAt: true } });
    const batch = await tx.importBatch.create({
      data: {
        id: batchId,
        organizationId: ctx.orgId,
        projectId: input.projectId,
        campaignId: input.campaignId ?? null,
        fileName: input.fileName,
        storageKey: att.storageKey,
        fileSha256: att.sha256,
        fileSize: att.size,
        sheetNames: sheets.map((s) => s.name),
        sheetName: first.name,
        headerRow,
        headers,
        totalRows: rows.length,
        mapping: (saved?.mapping ?? suggestMapping(headers)) as Prisma.InputJsonValue,
        options: { ...DEFAULT_OPTIONS, previousIdenticalBatchId: previous?.id ?? null } as Prisma.InputJsonValue,
        status: "PARSED",
        createdById: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "import.upload", entityType: "IMPORT", entityId: batch.id, projectId: input.projectId, summary: `${input.fileName} (${rows.length})`, meta: { sha256: att.sha256, sheets: sheets.length } });
    return batch;
  });
}

// ── 2. Preview & mapping ────────────────────────────────────────────────────

export async function getImportPreview(ctx: ServiceContext, batchId: string, override?: { sheetName?: string; headerRow?: number }) {
  const { batch, customFields, mappings } = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch } = await loadBatch(tx, ctx, batchId, "read");
    const customFields = await tx.customFieldDefinition.findMany({ where: { entityType: "RECIPIENT", archived: false, OR: [{ projectId: null }, { projectId: batch.projectId }] } });
    const mappings = await tx.importMapping.findMany({ where: { kind: "RECIPIENTS" }, orderBy: { createdAt: "desc" }, take: 20 });
    return { batch, customFields, mappings };
  });
  const effective = { ...batch, sheetName: override?.sheetName ?? batch.sheetName, headerRow: override?.headerRow ?? batch.headerRow };
  const { sheet, headers, rows } = await readTable(effective);
  const changedLayout = !!override && (override.sheetName !== batch.sheetName || override.headerRow !== batch.headerRow);
  return {
    batch: { id: batch.id, status: batch.status, fileName: batch.fileName, projectId: batch.projectId, campaignId: batch.campaignId, sheetNames: batch.sheetNames, options: readOptions(batch.options), previousIdenticalBatchId: (batch.options as { previousIdenticalBatchId?: string })?.previousIdenticalBatchId ?? null },
    sheetName: sheet.name,
    headerRow: effective.headerRow,
    headers,
    totalRows: rows.length,
    sample: rows.slice(0, 15),
    topRows: sheet.grid.slice(0, 8),
    mapping: (changedLayout ? suggestMapping(headers) : (batch.mapping as Mapping)) ?? suggestMapping(headers),
    canonical: CANONICAL_FIELDS.map((f) => ({ key: f.key, ar: f.ar, en: f.en })),
    customFields: customFields.map((c) => ({ key: `cf:${c.key}`, ar: c.labelAr, en: c.labelEn })),
    savedMappings: mappings.map((mm) => ({ id: mm.id, name: mm.name, mapping: mm.mapping as Mapping })),
  };
}

export const configureSchema = z.object({
  batchId: z.string(),
  sheetName: z.string().min(1),
  headerRow: z.number().int().min(1).max(50),
  mapping: z.record(z.string(), z.string().nullable()),
  options: optionsSchema,
  saveMappingAs: z.string().trim().max(100).nullish(),
});

/** Saves sheet/header/mapping/options and starts validation (inline or background). */
export async function configureAndValidate(ctx: ServiceContext, input: z.output<typeof configureSchema>) {
  const mapping = Object.fromEntries(Object.entries(input.mapping).filter(([, v]) => !!v)) as Mapping;
  const allowed = new Set([...CANONICAL_FIELDS.map((f) => f.key as string)]);
  for (const k of Object.keys(mapping)) if (!allowed.has(k) && !k.startsWith("cf:")) delete (mapping as Record<string, unknown>)[k];
  if (!mapping.nameAr && !mapping.nameEn) throw new ValidationError("errors.validation", { mapping: ["delivery.import.mapName"] });
  const owner = leaseToken("req");
  const batch = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch } = await loadBatch(tx, ctx, input.batchId);
    if (!["PARSED", "VALIDATED", "FAILED"].includes(batch.status)) throw new ValidationError("errors.importState");
    if (!batch.sheetNames.includes(input.sheetName)) throw new ValidationError("errors.validation");
    // compare-and-set claim: a double-clicked "validate" starts one validation, the other gets a conflict
    const claimed = await tx.importBatch.updateMany({
      where: { id: batch.id, status: batch.status },
      data: { sheetName: input.sheetName, headerRow: input.headerRow, mapping: mapping as Prisma.InputJsonValue, options: { ...(batch.options as object), ...input.options } as Prisma.InputJsonValue, status: "VALIDATING", progress: 0, error: null, leaseOwner: owner, leaseUntil: leaseEnd(), attempts: 1 },
    });
    if (!claimed.count) throw new ConflictError();
    const updated = await tx.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
    if (input.saveMappingAs) {
      await tx.importMapping.create({ data: { organizationId: ctx.orgId, name: input.saveMappingAs, mapping: mapping as Prisma.InputJsonValue, headerSignature: headerSignature(batch.headers), createdById: ctx.userId } });
    }
    await audit(tx, ctx, { action: "import.configure", entityType: "IMPORT", entityId: batch.id, projectId: batch.projectId, meta: { mapping, options: input.options } });
    return updated;
  });
  const mode = batch.totalRows > INLINE_ROW_LIMIT ? await enqueue("import.validate", { orgId: ctx.orgId, actorId: ctx.userId, batchId: batch.id }, { jobId: `import-validate-${batch.id}-${Date.now()}` }) : (await runValidation(ctx.orgId, ctx.userId, batch.id, owner), "inline");
  return { batchId: batch.id, mode };
}

// ── 3. Validation (job) ─────────────────────────────────────────────────────

interface Existing { id: string; mobile: string | null; email: string | null; externalRef: string | null; matchKey: string | null }

function chunked<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function findExisting(tx: Tx, scope: { projectId: string; orgWide: boolean }, keys: { mobiles: string[]; emails: string[]; refs: string[]; names: string[] }): Promise<Existing[]> {
  const out: Existing[] = [];
  const base = { deletedAt: null, ...(scope.orgWide ? {} : { projectId: scope.projectId }) };
  const select = { id: true, mobile: true, email: true, externalRef: true, matchKey: true };
  for (const part of chunked(keys.mobiles, 5000)) out.push(...(await tx.recipient.findMany({ where: { ...base, mobile: { in: part } }, select })));
  for (const part of chunked(keys.emails, 5000)) out.push(...(await tx.recipient.findMany({ where: { ...base, email: { in: part } }, select })));
  for (const part of chunked(keys.refs, 5000)) out.push(...(await tx.recipient.findMany({ where: { ...base, externalRef: { in: part } }, select })));
  for (const part of chunked(keys.names, 5000)) out.push(...(await tx.recipient.findMany({ where: { ...base, matchKey: { in: part } }, select })));
  return out;
}

function keyIndex(existing: Existing[]) {
  const idx = new Map<string, string>();
  for (const r of existing) {
    if (r.mobile) idx.set(`m:${r.mobile}`, r.id);
    if (r.email) idx.set(`e:${r.email.toLowerCase()}`, r.id);
    if (r.externalRef) idx.set(`r:${r.externalRef.toLowerCase()}`, r.id);
    if (r.matchKey) idx.set(r.matchKey, r.id);
  }
  return idx;
}

function classify(errors: unknown[], warnings: unknown[], dup: boolean): ImportRowStatus {
  if (errors.length) return "INVALID";
  if (dup) return "DUPLICATE";
  return warnings.length ? "WARNING" : "VALID";
}

/**
 * Validates a batch (idempotent: its rows are replaced as a whole). Holds the processing lease and
 * renews it after the parse, the duplicate lookup and every chunk; a run that loses it stops.
 */
export async function runValidation(orgId: string, actorId: string, batchId: string, owner?: string) {
  const ctx = { ...systemContext(orgId), userId: actorId };
  const token = await takeImportLease(orgId, batchId, "VALIDATING", owner);
  if (!token) return { skipped: true };
  const batch = await withTenant({ orgId }, (tx) => tx.importBatch.findUnique({ where: { id: batchId } }));
  if (!batch || batch.status !== "VALIDATING") return { skipped: true };
  const renew = () => withTenant({ orgId }, (tx) => renewImportLease(tx, batchId, "VALIDATING", token));
  try {
    const { rows } = await readTable(batch);
    await renew();
    const mapping = (batch.mapping ?? {}) as Mapping;
    const opts = readOptions(batch.options);
    const results = rows.map((r) => ({ r, res: normalizeRow(r.values, mapping, opts) }));
    const existing = await withTenant({ orgId }, (tx) =>
      findExisting(tx, { projectId: batch.projectId, orgWide: opts.duplicateScope === "ORGANIZATION" }, {
        mobiles: [...new Set(results.map((x) => x.res.normalized.mobile).filter((x): x is string => !!x && opts.matchOn.includes("mobile")))],
        emails: [...new Set(results.map((x) => x.res.normalized.email).filter((x): x is string => !!x && opts.matchOn.includes("email")))],
        refs: [...new Set(results.map((x) => x.res.normalized.externalRef).filter((x): x is string => !!x && opts.matchOn.includes("externalRef")))],
        names: opts.matchOn.includes("name") ? [...new Set(results.map((x) => nameKey(x.res.normalized)))] : [],
      }),
    );
    await renew();
    const idx = keyIndex(existing);
    const firstSeen = new Map<string, number>();
    const data: Prisma.ImportRowCreateManyInput[] = results.map(({ r, res }) => {
      let duplicateOfRecipientId: string | null = null;
      let duplicateOfRow: number | null = null;
      for (const k of res.keys) {
        if (!duplicateOfRecipientId && idx.has(k)) duplicateOfRecipientId = idx.get(k)!;
        if (!duplicateOfRow && firstSeen.has(k)) duplicateOfRow = firstSeen.get(k)!;
      }
      for (const k of res.keys) if (!firstSeen.has(k)) firstSeen.set(k, r.rowNumber);
      const status = classify(res.errors, res.warnings, !!(duplicateOfRecipientId || duplicateOfRow));
      return {
        organizationId: orgId,
        batchId,
        rowNumber: r.rowNumber,
        raw: r.values as Prisma.InputJsonValue,
        normalized: res.normalized as Prisma.InputJsonValue,
        status,
        errors: res.errors as unknown as Prisma.InputJsonValue,
        warnings: res.warnings as unknown as Prisma.InputJsonValue,
        matchKey: res.keys[0] ?? null,
        duplicateOfRecipientId,
        duplicateOfRow,
        resolution: "PENDING",
      };
    });
    await withTenant({ orgId }, async (tx) => {
      await renewImportLease(tx, batchId, "VALIDATING", token);
      await tx.importRow.deleteMany({ where: { batchId } });
    });
    let done = 0;
    for (const part of chunked(data, 1000)) {
      await withTenant({ orgId }, async (tx) => {
        // the lease check and the rows commit together: a run that lost the batch writes nothing
        await renewImportLease(tx, batchId, "VALIDATING", token);
        await tx.importRow.createMany({ data: part });
        done += part.length;
        await tx.importBatch.update({ where: { id: batchId }, data: { progress: Math.round((done / Math.max(1, data.length)) * 100) } });
      });
    }
    await withTenant({ orgId }, async (tx) => {
      await renewImportLease(tx, batchId, "VALIDATING", token);
      await tx.importBatch.update({ where: { id: batchId }, data: { leaseOwner: null, leaseUntil: null } });
    });
    await refreshCounts(orgId, batchId, "VALIDATED");
    await withTenant({ orgId, userId: actorId }, (tx) => audit(tx, ctx, { action: "import.validated", entityType: "IMPORT", entityId: batchId, projectId: batch.projectId, summary: `${data.length} rows` }));
    return { rows: data.length };
  } catch (err) {
    if (err instanceof LeaseLost) return { skipped: true, leaseLost: true };
    const message = err instanceof AppError ? err.message : "errors.unexpected";
    const failed = await withTenant({ orgId }, (tx) => tx.importBatch.updateMany({ where: { id: batchId, status: "VALIDATING", leaseOwner: token }, data: { status: "FAILED", error: message, leaseOwner: null, leaseUntil: null } }));
    if (!failed.count) return { skipped: true, leaseLost: true };
    await withTenant({ orgId, userId: actorId }, (tx) => emit(tx, ctx, "import.failed", { batchId, projectId: batch.projectId, link: `/projects/${batch.projectId}/delivery/imports/${batchId}` }));
    if (!(err instanceof AppError)) throw err;
    return { failed: true };
  }
}

async function refreshCounts(orgId: string, batchId: string, status?: "VALIDATED") {
  await withTenant({ orgId }, async (tx) => {
    const counts = await tx.importRow.groupBy({ by: ["status"], where: { batchId }, _count: true });
    const c = (s: string) => counts.find((x) => x.status === s)?._count ?? 0;
    await tx.importBatch.update({
      where: { id: batchId },
      data: { validRows: c("VALID"), warningRows: c("WARNING"), invalidRows: c("INVALID"), duplicateRows: c("DUPLICATE"), committedRows: c("COMMITTED"), totalRows: counts.reduce((n, x) => n + x._count, 0), ...(status ? { status, progress: 100 } : {}) },
    });
  });
}

// ── 4. Review: list rows, edit, resolve ─────────────────────────────────────

export async function listImportRows(ctx: ServiceContext, batchId: string, filter: { status?: string; take?: number; skip?: number } = {}) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch, scope } = await loadBatch(tx, ctx, batchId, "read");
    const where = { batchId, ...(filter.status ? { status: filter.status as ImportRowStatus } : {}) };
    const [rows, total, counts, history] = await Promise.all([
      tx.importRow.findMany({ where, orderBy: { rowNumber: "asc" }, take: Math.min(filter.take ?? 200, 1000), skip: filter.skip ?? 0 }),
      tx.importRow.count({ where }),
      tx.importRow.groupBy({ by: ["status"], where: { batchId }, _count: true }),
      tx.auditEvent.findMany({ where: { entityType: "IMPORT", entityId: batchId }, orderBy: { createdAt: "asc" } }),
    ]);
    const dupIds = [...new Set(rows.map((r) => r.duplicateOfRecipientId).filter((x): x is string => !!x))];
    const dups = await tx.recipient.findMany({ where: { id: { in: dupIds } }, select: { id: true, code: true, nameAr: true, nameEn: true, organizationName: true, projectId: true, mobile: true } });
    const campaign = batch.campaignId ? await tx.invitationCampaign.findUnique({ where: { id: batch.campaignId }, select: { id: true, name: true } }) : null;
    const mapping = (batch.mapping ?? {}) as Mapping;
    return {
      batch,
      campaign,
      rows: scope.vip ? rows : rows.map((r) => ({ ...r, raw: maskRawRow(r.raw, mapping) as Prisma.JsonValue, normalized: maskNormalizedRow(r.normalized) as Prisma.JsonValue, overrides: maskNormalizedRow(r.overrides) as Prisma.JsonValue })),
      total,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<string, number>,
      // an org-wide match in another project only says "exists elsewhere": no name, code, project or number
      duplicates: Object.fromEntries(
        dups.map((d) =>
          d.projectId === batch.projectId
            ? [d.id, { ...d, mobile: scope.vip ? d.mobile : d.mobile ? `•••${d.mobile.slice(-4)}` : null }]
            : [d.id, { id: d.id, code: "—", nameAr: null, nameEn: null, organizationName: null, projectId: "other", mobile: null }],
        ),
      ),
      history,
      vip: scope.vip,
    };
  });
}

export async function updateImportRow(ctx: ServiceContext, input: { batchId: string; rowId: string; overrides: Partial<NormalizedRecipient> }) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch } = await loadBatch(tx, ctx, input.batchId);
    if (batch.status !== "VALIDATED") throw new ValidationError("errors.importState");
    const row = await tx.importRow.findFirst({ where: { id: input.rowId, batchId: batch.id } });
    if (!row) throw new NotFoundError();
    const opts = readOptions(batch.options);
    const overrides = { ...((row.overrides as object) ?? {}), ...input.overrides };
    const res = normalizeRow(row.raw as Record<string, unknown>, (batch.mapping ?? {}) as Mapping, opts, overrides);
    // re-check duplicates for this row only
    const existing = await findExisting(tx, { projectId: batch.projectId, orgWide: opts.duplicateScope === "ORGANIZATION" }, {
      mobiles: res.normalized.mobile && opts.matchOn.includes("mobile") ? [res.normalized.mobile] : [],
      emails: res.normalized.email && opts.matchOn.includes("email") ? [res.normalized.email] : [],
      refs: res.normalized.externalRef && opts.matchOn.includes("externalRef") ? [res.normalized.externalRef] : [],
      names: opts.matchOn.includes("name") ? [nameKey(res.normalized)] : [],
    });
    const idx = keyIndex(existing);
    const dupRecipient = res.keys.map((k) => idx.get(k)).find(Boolean) ?? null;
    const others = await tx.importRow.findFirst({ where: { batchId: batch.id, rowNumber: { lt: row.rowNumber }, matchKey: { in: res.keys }, status: { notIn: ["SKIPPED", "INVALID"] } }, select: { rowNumber: true } });
    const status = classify(res.errors, res.warnings, !!(dupRecipient || others));
    const updated = await tx.importRow.update({
      where: { id: row.id },
      data: { overrides: overrides as Prisma.InputJsonValue, normalized: res.normalized as Prisma.InputJsonValue, errors: res.errors as unknown as Prisma.InputJsonValue, warnings: res.warnings as unknown as Prisma.InputJsonValue, status, matchKey: res.keys[0] ?? null, duplicateOfRecipientId: dupRecipient, duplicateOfRow: others?.rowNumber ?? null, resolution: "PENDING" },
    });
    await audit(tx, ctx, { action: "import.row_edit", entityType: "IMPORT", entityId: batch.id, projectId: batch.projectId, summary: `row ${row.rowNumber}`, meta: { fields: Object.keys(input.overrides), status } });
    const counts = await tx.importRow.groupBy({ by: ["status"], where: { batchId: batch.id }, _count: true });
    const c = (s: string) => counts.find((x) => x.status === s)?._count ?? 0;
    await tx.importBatch.update({ where: { id: batch.id }, data: { validRows: c("VALID"), warningRows: c("WARNING"), invalidRows: c("INVALID"), duplicateRows: c("DUPLICATE") } });
    return updated;
  });
}

export async function resolveRows(ctx: ServiceContext, input: { batchId: string; rowIds?: string[]; scope?: "ALL_DUPLICATES" | "ALL_INVALID"; resolution: "SKIP" | "IMPORT_AS_NEW" | "LINK_EXISTING" | "PENDING" }) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch } = await loadBatch(tx, ctx, input.batchId);
    if (batch.status !== "VALIDATED") throw new ValidationError("errors.importState");
    const where: Prisma.ImportRowWhereInput = { batchId: batch.id, ...(input.rowIds ? { id: { in: input.rowIds } } : input.scope === "ALL_INVALID" ? { status: "INVALID" } : { status: "DUPLICATE" }) };
    // Only rows that matched an existing recipient can be linked; invalid rows can only be skipped.
    if (input.resolution === "LINK_EXISTING") where.duplicateOfRecipientId = { not: null };
    if (input.resolution !== "SKIP" && input.resolution !== "PENDING") where.status = { not: "INVALID" };
    const r = await tx.importRow.updateMany({ where, data: { resolution: input.resolution } });
    await audit(tx, ctx, { action: "import.resolve", entityType: "IMPORT", entityId: batch.id, projectId: batch.projectId, summary: `${r.count} → ${input.resolution}` });
    return { updated: r.count };
  });
}

// ── 5. Commit ───────────────────────────────────────────────────────────────

export const commitSchema = z.object({ batchId: z.string(), includeWarnings: z.boolean().default(true), acceptPartial: z.boolean().default(false), campaignId: z.string().nullish() });

export async function commitImport(ctx: ServiceContext, input: z.output<typeof commitSchema>) {
  const owner = leaseToken("req");
  const batch = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch } = await loadBatch(tx, ctx, input.batchId);
    if (batch.status !== "VALIDATED") throw new ValidationError("errors.importState");
    if (input.campaignId !== undefined && input.campaignId !== batch.campaignId) {
      if (input.campaignId && !(await tx.invitationCampaign.findFirst({ where: { id: input.campaignId, projectId: batch.projectId, type: "PHYSICAL" } }))) throw new NotFoundError();
    }
    const blocking = await tx.importRow.count({ where: { batchId: batch.id, OR: [{ status: "INVALID", resolution: { not: "SKIP" } }, { status: "DUPLICATE", resolution: "PENDING" }] } });
    const importable = await tx.importRow.count({ where: { batchId: batch.id, OR: [{ status: "VALID" }, ...(input.includeWarnings ? [{ status: "WARNING" as const }] : []), { status: "DUPLICATE", resolution: { in: ["IMPORT_AS_NEW", "LINK_EXISTING"] } }] } });
    if (!importable) throw new ValidationError("errors.noRowsSelected");
    // Partial imports require explicit approval — never silently drop rows.
    if (blocking > 0 && !input.acceptPartial) throw new AppError("delivery.import.partialRequired", "PARTIAL_REQUIRED", 409);
    const claimed = await tx.importBatch.updateMany({
      where: { id: batch.id, status: "VALIDATED" },
      data: { status: "COMMITTING", progress: 0, leaseOwner: owner, leaseUntil: leaseEnd(), attempts: 1, committedById: ctx.userId, campaignId: input.campaignId === undefined ? batch.campaignId : input.campaignId, options: { ...(batch.options as object), includeWarnings: input.includeWarnings, acceptPartial: input.acceptPartial } as Prisma.InputJsonValue },
    });
    if (!claimed.count) throw new ConflictError();
    await audit(tx, ctx, { action: "import.commit_start", entityType: "IMPORT", entityId: batch.id, projectId: batch.projectId, meta: { importable, blocking, acceptPartial: input.acceptPartial } });
    return { ...batch, importable };
  });
  const mode = batch.importable > INLINE_ROW_LIMIT ? await enqueue("import.commit", { orgId: ctx.orgId, actorId: ctx.userId, batchId: batch.id }, { jobId: `import-commit-${batch.id}` }) : (await runCommit(ctx.orgId, ctx.userId, batch.id, owner), "inline");
  return { batchId: batch.id, mode };
}

async function nextRecipientNumber(tx: Tx, projectId: string): Promise<number> {
  const last = await tx.$queryRaw<{ n: number | null }[]>`SELECT max(nullif(regexp_replace(code, '\\D', '', 'g'), '')::int) AS n FROM "Recipient" WHERE "projectId" = ${projectId}`;
  return (last[0]?.n ?? 0) + 1;
}

/**
 * Idempotent, chunked commit. Safe to re-run after a crash: it resumes from the first row not
 * COMMITTED, and each row moves to COMMITTED (compare-and-set) in the same transaction as its
 * recipient and delivery card, under the lease check, so no row is committed twice.
 */
export async function runCommit(orgId: string, actorId: string, batchId: string, owner?: string, opts: { stopAfterChunks?: number } = {}) {
  const ctx = { ...systemContext(orgId), userId: actorId };
  const token = await takeImportLease(orgId, batchId, "COMMITTING", owner);
  if (!token) return { skipped: true };
  const batch = await withTenant({ orgId }, (tx) => tx.importBatch.findUnique({ where: { id: batchId } }));
  if (!batch || batch.status !== "COMMITTING") return { skipped: true };
  try {
    return await commitChunks(orgId, actorId, batch, token, ctx, opts.stopAfterChunks);
  } catch (err) {
    if (err instanceof LeaseLost) return { skipped: true, leaseLost: true };
    throw err;
  }
}

/** `stopAfterChunks` ends the run early without finishing, as a crashed process would (recovery tests). */
async function commitChunks(orgId: string, actorId: string, batch: Prisma.ImportBatchGetPayload<object>, token: string, ctx: ServiceContext, stopAfterChunks?: number) {
  const batchId = batch.id;
  let chunks = 0;
  const opts = batch.options as { includeWarnings?: boolean };
  const statuses: ImportRowStatus[] = opts.includeWarnings === false ? ["VALID"] : ["VALID", "WARNING"];
  const config = batch.campaignId ? await withTenant({ orgId }, (tx) => tx.invitationCampaign.findUnique({ where: { id: batch.campaignId! } })) : null;
  let created = 0;
  let linked = 0;
  for (;;) {
    const n = await withTenant({ orgId, userId: actorId }, async (tx) => {
      // serialize code allocation per project across concurrent imports
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${batch.projectId}))`;
      await renewImportLease(tx, batchId, "COMMITTING", token);
      const rows = await tx.importRow.findMany({
        where: { batchId, OR: [{ status: { in: statuses } }, { status: "DUPLICATE", resolution: { in: ["IMPORT_AS_NEW", "LINK_EXISTING"] } }] },
        orderBy: { rowNumber: "asc" },
        take: CHUNK,
      });
      if (!rows.length) return 0;
      let seq = await nextRecipientNumber(tx, batch.projectId);
      const recipients: Prisma.RecipientCreateManyInput[] = [];
      const deliveries: Prisma.DeliveryCreateManyInput[] = [];
      const rowUpdates: { id: string; recipientId: string }[] = [];
      const customValues: Prisma.CustomFieldValueCreateManyInput[] = [];
      const defs = await tx.customFieldDefinition.findMany({ where: { entityType: "RECIPIENT", archived: false, OR: [{ projectId: null }, { projectId: batch.projectId }] } });
      const retentionDays = Number(((await tx.organization.findUnique({ where: { id: orgId }, select: { settings: true } }))?.settings as { recipientRetentionDays?: number })?.recipientRetentionDays ?? 365);
      for (const row of rows) {
        const nr = row.normalized as NormalizedRecipient;
        let recipientId: string;
        if (row.status === "DUPLICATE" && row.resolution === "LINK_EXISTING" && row.duplicateOfRecipientId) {
          recipientId = row.duplicateOfRecipientId;
          // linking never overwrites the existing record; for org-scope matches in another project, create a project copy
          const existing = await tx.recipient.findUnique({ where: { id: recipientId } });
          if (!existing || existing.projectId !== batch.projectId) {
            recipientId = "";
          } else linked++;
        } else recipientId = "";
        if (!recipientId) {
          recipientId = createId();
          recipients.push({
            id: recipientId,
            organizationId: orgId,
            projectId: batch.projectId,
            code: `R-${String(seq++).padStart(5, "0")}`,
            externalRef: nr.externalRef ?? null,
            nameAr: nr.nameAr ?? null,
            nameEn: nr.nameEn ?? null,
            honorific: nr.honorific ?? null,
            jobTitle: nr.jobTitle ?? null,
            organizationName: nr.organizationName ?? null,
            vipTier: nr.vipTier ?? null,
            category: nr.category ?? null,
            mobile: nr.mobile ?? null,
            mobileRaw: nr.mobileRaw ?? null,
            altPhone: nr.altPhone ?? null,
            email: nr.email ?? null,
            address: nr.address ?? null,
            city: nr.city ?? null,
            district: nr.district ?? null,
            mapsUrl: nr.mapsUrl ?? null,
            lat: nr.lat ?? null,
            lng: nr.lng ?? null,
            deliveryInstructions: nr.deliveryInstructions ?? null,
            preferredWindow: nr.preferredWindow ?? null,
            invitationType: nr.invitationType ?? config?.invitationType ?? null,
            priority: nr.priority ?? "MEDIUM",
            notes: nr.notes ?? null,
            matchKey: nameKey(nr),
            verificationStatus: nr.mobile ? "UNVERIFIED" : "INVALID",
            retentionUntil: new Date(Date.now() + retentionDays * 86400_000),
            importBatchId: batchId,
            importRowId: row.id,
            createdById: actorId,
          });
          for (const [k, v] of Object.entries(nr.custom ?? {})) {
            const def = defs.find((d) => d.key === k);
            if (def && v !== null) customValues.push({ organizationId: orgId, definitionId: def.id, entityType: "RECIPIENT", entityId: recipientId, value: v as Prisma.InputJsonValue });
          }
          created++;
        }
        rowUpdates.push({ id: row.id, recipientId });
        if (batch.campaignId) {
          const hasLocation = !!(nr.address || nr.mapsUrl || (nr.lat != null && nr.lng != null));
          deliveries.push({ id: createId(), organizationId: orgId, projectId: batch.projectId, campaignId: batch.campaignId, recipientId, importBatchId: batchId, trackingCode: `DLV-${shortCode(7)}`, status: hasLocation ? "READY" : "PENDING", priority: nr.priority ?? "MEDIUM" });
        }
      }
      if (recipients.length) await tx.recipient.createMany({ data: recipients });
      if (customValues.length) await tx.customFieldValue.createMany({ data: customValues, skipDuplicates: true });
      if (deliveries.length) {
        // (campaign, recipient) is unique: existing cards for linked recipients are kept, not duplicated
        const existing = await tx.delivery.findMany({ where: { campaignId: batch.campaignId!, recipientId: { in: deliveries.map((d) => d.recipientId) } }, select: { recipientId: true } });
        const have = new Set(existing.map((e) => e.recipientId));
        const fresh = deliveries.filter((d) => !have.has(d.recipientId));
        if (fresh.length) {
          await tx.delivery.createMany({ data: fresh });
          await tx.deliveryEvent.createMany({ data: fresh.map((d) => ({ organizationId: orgId, deliveryId: d.id!, toStatus: d.status!, actorId, source: "IMPORT", note: batch.fileName })) });
        }
      }
      for (const u of rowUpdates) {
        const moved = await tx.importRow.updateMany({ where: { id: u.id, status: { not: "COMMITTED" } }, data: { status: "COMMITTED", recipientId: u.recipientId } });
        if (!moved.count) throw new ConflictError(); // never: rows are claimed under the project lock
      }
      const done = await tx.importRow.count({ where: { batchId, status: "COMMITTED" } });
      await tx.importBatch.update({ where: { id: batchId }, data: { committedRows: done, progress: Math.min(99, Math.round((done / Math.max(1, batch.totalRows)) * 100)) } });
      return rows.length;
    }, { timeout: 120_000 });
    if (!n) break;
    if (stopAfterChunks !== undefined && ++chunks >= stopAfterChunks) return { created, linked, stopped: true };
  }
  await withTenant({ orgId, userId: actorId }, async (tx) => {
    await renewImportLease(tx, batchId, "COMMITTING", token);
    await tx.importRow.updateMany({ where: { batchId, status: { notIn: ["COMMITTED"] } }, data: { status: "SKIPPED" } });
    const skipped = await tx.importRow.count({ where: { batchId, status: "SKIPPED" } });
    const committed = await tx.importRow.count({ where: { batchId, status: "COMMITTED" } });
    await tx.importBatch.update({ where: { id: batchId }, data: { status: skipped ? "PARTIALLY_COMMITTED" : "COMMITTED", committedRows: committed, committedAt: new Date(), progress: 100, leaseOwner: null, leaseUntil: null } });
    await audit(tx, ctx, { action: "import.commit", entityType: "IMPORT", entityId: batchId, projectId: batch.projectId, summary: `${committed} committed, ${skipped} skipped`, meta: { created, linked, campaignId: batch.campaignId } });
    await emit(tx, ctx, "import.completed", { batchId, projectId: batch.projectId, count: committed, link: `/projects/${batch.projectId}/delivery/imports/${batchId}`, entityType: "IMPORT", entityId: batchId });
  });
  return { created, linked };
}

// ── 6. Rollback ─────────────────────────────────────────────────────────────

/**
 * Rolls back a committed batch only when it is safe: none of the recipients it created were
 * edited afterwards and none of its delivery cards were assigned, attempted or progressed.
 */
export async function rollbackImport(ctx: ServiceContext, batchId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch, scope } = await loadBatch(tx, ctx, batchId);
    if (!scope.manage && !scope.operate) throw new ForbiddenError();
    if (!["COMMITTED", "PARTIALLY_COMMITTED"].includes(batch.status) || !batch.committedAt) throw new ValidationError("errors.importState");
    const safeUntil = new Date(batch.committedAt.getTime() + 5_000);
    const modifiedRecipients = await tx.recipient.count({ where: { importBatchId: batchId, updatedAt: { gt: safeUntil } } });
    const progressedDeliveries = await tx.delivery.count({ where: { importBatchId: batchId, OR: [{ status: { notIn: ["PENDING", "VALIDATING", "READY"] } }, { attemptsCount: { gt: 0 } }, { agentId: { not: null } }, { batchId: { not: null } }] } });
    const linkedElsewhere = await tx.delivery.count({ where: { recipient: { importBatchId: batchId }, importBatchId: { not: batchId } } });
    // recipients already used by a digital audience or the protocol guest list are not ours to delete
    const ids = (await tx.recipient.findMany({ where: { importBatchId: batchId }, select: { id: true } })).map((r) => r.id);
    const usedElsewhere = ids.length ? (await tx.digitalInvitation.count({ where: { recipientId: { in: ids } } })) + (await tx.guest.count({ where: { recipientId: { in: ids } } })) : 0;
    const blocked = modifiedRecipients + progressedDeliveries + linkedElsewhere + usedElsewhere;
    if (blocked) throw new AppError("errors.rollbackUnsafe", "ROLLBACK_UNSAFE", 409, { blocked: [String(blocked)] });
    const claimed = await tx.importBatch.updateMany({ where: { id: batchId, status: batch.status }, data: { status: "ROLLED_BACK", rolledBackAt: new Date(), rolledBackById: ctx.userId } });
    if (!claimed.count) throw new ConflictError();
    const d = await tx.delivery.deleteMany({ where: { importBatchId: batchId } });
    const r = await tx.recipient.deleteMany({ where: { importBatchId: batchId } });
    await tx.importRow.updateMany({ where: { batchId, status: "COMMITTED" }, data: { status: "ROLLED_BACK" } });
    await audit(tx, ctx, { action: "import.rollback", entityType: "IMPORT", entityId: batchId, projectId: batch.projectId, summary: `${r.count} recipients, ${d.count} deliveries removed` });
    return { recipients: r.count, deliveries: d.count };
  });
}

export async function listImports(ctx: ServiceContext, projectId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    await projectScope(tx, ctx, projectId);
    return tx.importBatch.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 100 });
  });
}

export async function importStatus(ctx: ServiceContext, batchId: string) {
  return withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch } = await loadBatch(tx, ctx, batchId, "read");
    return { status: batch.status, progress: batch.progress, committedRows: batch.committedRows, totalRows: batch.totalRows, error: batch.error, ...importLeaseState(batch) };
  });
}

// ── 8. Stalled imports (BUSINESS_RULES §7.1) ────────────────────────────────

type LeaseFields = Pick<Prisma.ImportBatchGetPayload<object>, "status" | "leaseUntil" | "updatedAt" | "attempts">;

/** When the batch's lease runs out (a batch without one counts from its last change). */
function leaseExpiry(b: LeaseFields) {
  return b.leaseUntil ?? new Date(b.updatedAt.getTime() + IMPORT_LEASE_MS);
}

/**
 * What the wizard shows while a stage runs: "paused" once the lease expired (the sweep resumes it),
 * and "Resume now" once it has been expired for more than 120 s.
 */
export function importLeaseState(b: LeaseFields, now = new Date()) {
  const running = b.status === "VALIDATING" || b.status === "COMMITTING";
  const expiry = leaseExpiry(b).getTime();
  return {
    paused: running && expiry < now.getTime(),
    resumable: running && expiry < now.getTime() - IMPORT_LEASE_MS,
    attempts: b.attempts,
    maxAttempts: IMPORT_MAX_ATTEMPTS,
    lastProgressAt: b.updatedAt,
    /** when the recovery sweep will next try (the scheduler tick after the lease expired) */
    nextAttemptAt: new Date(Math.max(now.getTime(), expiry) + 60_000),
  };
}

export type ImportRecovery = "resumed" | "failed" | "partial" | "live" | "busy" | "not_running";

/**
 * Gives up on a stage after {@link IMPORT_MAX_ATTEMPTS}: VALIDATING → FAILED (`import.stalled`);
 * COMMITTING → PARTIALLY_COMMITTED when rows were committed (rollback stays available), else FAILED.
 * The person who started the stage gets one notice (and the PMs too for a commit).
 */
async function giveUpImport(tx: Tx, b: Prisma.ImportBatchGetPayload<object>, now: Date): Promise<ImportRecovery> {
  const ctx = systemContext(b.organizationId);
  const where = { id: b.id, status: b.status, attempts: b.attempts, leaseOwner: b.leaseOwner };
  const committed = b.status === "COMMITTING" ? await tx.importRow.count({ where: { batchId: b.id, status: "COMMITTED" } }) : 0;
  const partial = committed > 0;
  const r = await tx.importBatch.updateMany({
    where,
    data: partial
      ? { status: "PARTIALLY_COMMITTED", committedRows: committed, committedAt: now, progress: 100, error: "import.stalled", leaseOwner: null, leaseUntil: null }
      : { status: "FAILED", error: "import.stalled", leaseOwner: null, leaseUntil: null },
  });
  if (!r.count) return "busy";
  if (partial) await tx.importRow.updateMany({ where: { batchId: b.id, status: { not: "COMMITTED" } }, data: { status: "SKIPPED" } });
  const actor = b.status === "COMMITTING" ? b.committedById ?? b.createdById : b.createdById;
  const pms = b.status === "COMMITTING" ? (await tx.projectMember.findMany({ where: { projectId: b.projectId, role: "MANAGER" }, select: { userId: true } })).map((x) => x.userId) : [];
  await notify(tx, {
    orgId: b.organizationId,
    userIds: [actor, ...pms],
    type: "import.stalled",
    titleKey: "notif.types.importStalled",
    params: { name: b.fileName },
    link: `/projects/${b.projectId}/delivery/imports/${b.id}`,
    entityType: "IMPORT",
    entityId: b.id,
    dedupeKey: `import.stalled:${b.id}:${b.status}`,
    priority: "HIGH",
  });
  await audit(tx, ctx, { action: "import.stalled", entityType: "IMPORT", entityId: b.id, projectId: b.projectId, summary: partial ? `${committed} committed, rest skipped` : "failed", meta: { stage: b.status, attempts: b.attempts, committed } });
  return partial ? "partial" : "failed";
}

/**
 * The single recovery path for an import whose lease expired (§7.1 rules 2–3), used by the sweep
 * (`minExpiredMs` 0) and by "Resume now" (lease expired for more than 120 s). It resumes the stage —
 * validation restarts, a commit continues from the first row not committed — or gives up after the
 * third attempt. A resume counts as an attempt; a second call while the resumed run holds the lease
 * does nothing.
 */
export async function recoverImport(orgId: string, batchId: string, opts: { now?: Date; minExpiredMs?: number; by?: ServiceContext } = {}): Promise<ImportRecovery> {
  const now = opts.now ?? new Date();
  const claim = await withTenant({ orgId }, async (tx): Promise<{ outcome: ImportRecovery; batch?: Prisma.ImportBatchGetPayload<object> }> => {
    const b = await tx.importBatch.findUnique({ where: { id: batchId } });
    if (!b || (b.status !== "VALIDATING" && b.status !== "COMMITTING")) return { outcome: "not_running" };
    if (leaseExpiry(b).getTime() > now.getTime() - (opts.minExpiredMs ?? 0)) return { outcome: "live" };
    const project = await tx.project.findUnique({ where: { id: b.projectId }, select: { status: true } });
    // an archived project takes no more writes (LC rule 5): the stage stops where it is
    if (b.attempts >= IMPORT_MAX_ATTEMPTS || !project || ["CLOSED", "CANCELLED"].includes(project.status)) return { outcome: await giveUpImport(tx, b, now) };
    const r = await tx.importBatch.updateMany({
      where: { id: b.id, status: b.status, attempts: b.attempts, leaseOwner: b.leaseOwner },
      data: { leaseOwner: leaseToken("resume"), leaseUntil: new Date(now.getTime() + IMPORT_LEASE_MS), attempts: { increment: 1 } },
    });
    if (!r.count) return { outcome: "busy" };
    await audit(tx, opts.by ?? systemContext(orgId), { action: "import.resume", entityType: "IMPORT", entityId: b.id, projectId: b.projectId, summary: `${b.status} · attempt ${b.attempts + 1}/${IMPORT_MAX_ATTEMPTS}`, meta: { stage: b.status, attempt: b.attempts + 1, manual: !!opts.by } });
    return { outcome: "resumed", batch: b };
  });
  if (claim.outcome === "resumed" && claim.batch) {
    const b = claim.batch;
    // the job adopts the resume's lease (no owner in the payload); inline mode runs it right here
    if (b.status === "VALIDATING") await enqueue("import.validate", { orgId, actorId: b.createdById, batchId }, { jobId: `import-resume-${batchId}-${b.attempts + 1}` });
    else await enqueue("import.commit", { orgId, actorId: b.committedById ?? b.createdById, batchId }, { jobId: `import-resume-${batchId}-${b.attempts + 1}` });
  }
  return claim.outcome;
}

/** "Resume now" on the wizard: the starter or any `recipient.import` holder, once the lease has been expired > 120 s (SW-3). */
export async function resumeImport(ctx: ServiceContext, batchId: string) {
  await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch } = await loadBatch(tx, ctx, batchId);
    if (batch.status !== "VALIDATING" && batch.status !== "COMMITTING") throw new ValidationError("errors.importNotResumable");
  });
  const outcome = await recoverImport(ctx.orgId, batchId, { minExpiredMs: IMPORT_LEASE_MS, by: ctx });
  return { outcome };
}

/** Sweep step (scheduler tick): every import whose lease ran out is resumed or given up. */
export async function recoverStalledImports(orgId: string, now = new Date()) {
  const stale = await withTenant({ orgId }, (tx) =>
    tx.importBatch.findMany({
      where: { status: { in: ["VALIDATING", "COMMITTING"] }, OR: [{ leaseUntil: { lt: now } }, { leaseUntil: null, updatedAt: { lt: new Date(now.getTime() - IMPORT_LEASE_MS) } }] },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
      take: 10,
    }),
  );
  const out = { resumed: 0, failed: 0 };
  for (const b of stale) {
    const r = await recoverImport(orgId, b.id, { now }).catch((e) => {
      console.error(`[recovery] import ${b.id}`, (e as Error).message);
      return "busy" as const;
    });
    if (r === "resumed") out.resumed++;
    if (r === "failed" || r === "partial") out.failed++;
  }
  return out;
}

// ── 7. Reports ──────────────────────────────────────────────────────────────

/** Error report / normalized export as XLSX. All cells are formula-neutralized. */
export async function importReport(ctx: ServiceContext, batchId: string, kind: "errors" | "normalized" | "original", messages: (code: string) => string) {
  const { batch, rows } = await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, async (tx) => {
    const { batch, scope } = await loadBatch(tx, ctx, batchId, "read");
    if (kind !== "errors" && !scope.vip && !scope.export) throw new ForbiddenError();
    const found = await tx.importRow.findMany({ where: { batchId, ...(kind === "errors" ? { status: { in: ["INVALID", "DUPLICATE", "WARNING", "SKIPPED"] } } : {}) }, orderBy: { rowNumber: "asc" } });
    // without VIP scope the report carries no contact data
    const rows = scope.vip ? found : found.map((r) => ({ ...r, raw: maskRawRow(r.raw, (batch.mapping ?? {}) as Mapping) as Prisma.JsonValue, normalized: maskNormalizedRow(r.normalized) as Prisma.JsonValue }));
    await audit(tx, ctx, { action: "export.import_report", entityType: "IMPORT", entityId: batchId, projectId: batch.projectId, meta: { kind, rows: rows.length, masked: !scope.vip } });
    return { batch, rows };
  });
  const wb = new ExcelJS.Workbook();
  wb.creator = "Opera";
  const ws = wb.addWorksheet(kind === "errors" ? "Errors" : kind === "normalized" ? "Normalized" : "Original", { views: [{ rightToLeft: ctx.locale === "ar" }] });
  const canonical = CANONICAL_FIELDS.map((f) => f.key);
  const headers = kind === "normalized" ? ["row", "status", ...canonical] : ["row", "status", "errors", "warnings", ...batch.headers];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  // KD-4: user values are string cells; E.164 phones in phone columns are written without an apostrophe
  const mapping = (batch.mapping ?? {}) as Mapping;
  const phoneHeaders = new Set([mapping.mobile, mapping.altPhone].filter(Boolean));
  const phoneColumns = new Set(kind === "normalized" ? canonical.flatMap((k, i) => (k === "mobile" || k === "altPhone" ? [i + 2] : [])) : batch.headers.flatMap((h, i) => (phoneHeaders.has(h) ? [i + 4] : [])));
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  for (const r of rows) {
    const issues = (xs: unknown) => (xs as { field: string; code: string }[]).map((i) => `${i.field}: ${messages(i.code)}`).join("; ");
    if (kind === "normalized") {
      const nr = (r.normalized ?? {}) as Record<string, unknown>;
      addXlsxRow(ws, [r.rowNumber, r.status, ...canonical.map((k) => str(nr[k]))], phoneColumns);
    } else {
      const raw = r.raw as Record<string, unknown>;
      addXlsxRow(ws, [r.rowNumber, r.status, issues(r.errors) + (r.duplicateOfRow ? `; duplicate of row ${r.duplicateOfRow}` : r.duplicateOfRecipientId ? "; duplicate of existing recipient" : ""), issues(r.warnings), ...batch.headers.map((h) => str(raw[h]))], phoneColumns);
    }
  }
  ws.columns.forEach((c) => (c.width = 18));
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `${batch.fileName.replace(/\.[^.]+$/, "")}-${kind}.xlsx` };
}
