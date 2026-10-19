import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { appSecret, hmacHex, safeEqual } from "@/server/auth/crypto";

export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Short-lived URL the browser can use. For S3 a presigned URL; for local an HMAC-signed app route. */
  signedUrl(key: string, opts: { expiresIn: number; fileName: string; contentType: string; attachmentId: string }): Promise<string>;
}

/** Keys are always namespaced per tenant: org/<orgId>/<area>/<id>/<file> */
export function tenantKey(orgId: string, area: string, id: string, fileName: string) {
  const safe = fileName.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-120) || "file";
  return `org/${orgId}/${area}/${id}/${safe}`;
}

class LocalDriver implements StorageDriver {
  private root = resolve(process.env.STORAGE_LOCAL_DIR ?? "./storage");
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error("invalid storage key");
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async signedUrl(_key: string, opts: { expiresIn: number; attachmentId: string }) {
    const exp = Math.floor(Date.now() / 1000) + opts.expiresIn;
    const sig = hmacHex(appSecret(), `${opts.attachmentId}.${exp}`);
    return `/api/files/${opts.attachmentId}?exp=${exp}&sig=${sig}`;
  }
}

export function verifyLocalSignature(attachmentId: string, exp: string | null, sig: string | null) {
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  return safeEqual(hmacHex(appSecret(), `${attachmentId}.${exp}`), sig);
}

class S3Driver implements StorageDriver {
  private clientP = (async () => {
    const { S3Client } = await import("@aws-sdk/client-s3");
    return new S3Client({
      region: process.env.S3_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: process.env.S3_ACCESS_KEY_ID ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "" } : undefined,
    });
  })();
  private bucket = process.env.S3_BUCKET ?? "operra-private";
  async put(key: string, body: Buffer, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientP).send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "AES256" }));
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const r = await (await this.clientP).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientP).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async signedUrl(key: string, opts: { expiresIn: number; fileName: string; contentType: string }) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return getSignedUrl(
      await this.clientP,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`, ResponseContentType: opts.contentType }),
      { expiresIn: opts.expiresIn },
    );
  }
}

let driver: StorageDriver | undefined;
export function storage(): StorageDriver {
  return (driver ??= process.env.STORAGE_DRIVER === "s3" ? new S3Driver() : new LocalDriver());
}

export const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip", "image/svg+xml", "application/dwg", "image/vnd.dwg", "application/octet-stream",
]);

/** Magic-byte sniffing for the types we render inline; rejects disguised executables. */
export function sniffMime(buf: Buffer, declared: string, fileName: string): string | null {
  const head = buf.subarray(0, 12);
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (head.subarray(0, 4).toString() === "%PDF") return "application/pdf";
  if (head.subarray(4, 8).toString() === "ftyp") return declared.startsWith("image/hei") ? declared : "image/heic";
  if (head[0] === 0x4d && head[1] === 0x5a) return null; // Windows executable
  if (head.subarray(0, 4).toString("hex") === "7f454c46") return null; // ELF
  if (head[0] === 0x50 && head[1] === 0x4b) {
    // zip container: xlsx/docx/pptx/zip
    const ext = fileName.toLowerCase().split(".").pop();
    if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    return "application/zip";
  }
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "csv") return "text/csv";
  if (ext === "dwg") return "application/dwg";
  if (ext === "xls") return "application/vnd.ms-excel";
  if (ext === "svg") return "image/svg+xml";
  return ALLOWED_MIME.has(declared) ? declared : null;
}

export function maxUploadBytes() {
  return Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024;
}
