import QRCode from "qrcode";
import { CalendarDays, MapPin } from "lucide-react";
import { getI18n } from "@/lib/i18n/server";
import { formatDateTime } from "@/lib/format";
import { getRsvpPage } from "@/server/modules/digital/service";
import { RsvpForm } from "./rsvp-form";

export const metadata = { title: "RSVP", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function RsvpPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ optout?: string }> }) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const { m, locale, dir } = await getI18n();
  const p = m.digital.public;
  const data = await getRsvpPage(token);
  const shell = (children: React.ReactNode, brandColor?: string | null) => {
    const brand = brandColor && /^#[0-9a-fA-F]{3,8}$/.test(brandColor) ? brandColor : null;
    return (
    <div dir={dir} className="min-h-dvh bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-md overflow-hidden rounded-xl border bg-card">
        <div className="h-1.5" style={{ background: brand ?? "var(--brand-violet)" }} />
        <div className="p-6">{children}</div>
      </div>
      <p className="mx-auto mt-4 max-w-md text-center text-[11px] text-muted-foreground">{p.privacy}</p>
    </div>
    );
  };
  if (!data) return shell(<h1 className="text-lg font-medium">{m.errors.tokenInvalid}</h1>);

  const name = (locale === "en" ? data.recipient?.nameEn ?? data.recipient?.nameAr : data.recipient?.nameAr ?? data.recipient?.nameEn) ?? "";
  const orgName = locale === "en" ? data.org.nameEn ?? data.org.name : data.org.name;
  const qrSvg = data.qrCode ? await QRCode.toString(data.qrCode, { type: "svg", margin: 1, width: 200 }) : null;

  return shell(
    <div className="grid gap-5">
      <div>
        <p className="eyebrow">{orgName}</p>
        <h1 className="mt-3 text-xl font-medium">{p.dear} {data.recipient?.honorific} {name}</h1>
        {data.event && (
          <div className="mt-3 grid gap-1.5 text-sm">
            <p className="text-muted-foreground">{p.invited}</p>
            <p className="text-base font-medium">{data.event.name}</p>
            <p className="flex items-center gap-1.5 text-muted-foreground"><CalendarDays className="size-4" /><span className="ltr-nums">{formatDateTime(data.event.startsAt, { locale })}</span></p>
            {data.event.venue && <p className="flex items-center gap-1.5 text-muted-foreground"><MapPin className="size-4" />{data.event.venue.name}{data.event.venue.city ? ` — ${data.event.venue.city}` : ""}</p>}
          </div>
        )}
      </div>
      {qrSvg && (
        <div className="grid justify-items-center gap-2 rounded-lg border bg-white p-4 text-black">
          <div className="size-[200px]" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <p className="text-xs">{p.yourCode}: <span className="ltr-nums font-mono">{data.qrCode}</span></p>
        </div>
      )}
      <RsvpForm
        token={token}
        status={data.rsvpStatus}
        closed={data.closed || !data.campaign.rsvpEnabled}
        suppressed={data.suppressed}
        askOptOut={sp.optout === "1"}
      />
    </div>,
    data.org.brandColor,
  );
}
