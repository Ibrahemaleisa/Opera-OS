import { NextResponse, type NextRequest } from "next/server";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { verifyAndParseWebhook } from "@/server/modules/digital/providers";
import { applyProviderEvent } from "@/server/modules/digital/sender";
import { jsonError } from "@/server/route";

const PROVIDERS = new Set(["simulation", "whatsapp_cloud", "unifonic"]);

/** Inbound delivery receipts. Signature is verified over the raw body before anything is parsed. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await params;
    if (!PROVIDERS.has(provider)) return new NextResponse("Not found", { status: 404 });
    await enforceRateLimit(`webhook:${provider}`, 3000, 60);
    const raw = await req.text();
    if (raw.length > 256 * 1024) return new NextResponse("Payload too large", { status: 413 });
    const events = verifyAndParseWebhook(provider, raw, req.headers);
    if (!events) return new NextResponse("Invalid signature", { status: 401 });
    const payload = JSON.parse(raw);
    const results = [];
    for (const ev of events) results.push(await applyProviderEvent(provider, ev, payload));
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return jsonError(e);
  }
}

/** WhatsApp Cloud API subscription verification handshake. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const sp = req.nextUrl.searchParams;
  if (provider === "whatsapp_cloud" && sp.get("hub.mode") === "subscribe" && process.env.WHATSAPP_VERIFY_TOKEN && sp.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(sp.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}
