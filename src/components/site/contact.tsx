import { COMPANY } from "@/content/company";
import type { SiteCopy } from "@/content/site-copy";
import { Container, SectionMark } from "./primitives";

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-mist/15 py-5 sm:flex-row sm:items-baseline sm:justify-between">
      <dt className="text-sm text-mist/60">{label}</dt>
      <dd className="text-lg">
        {href ? <a href={href} className="ltr-nums rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-lilac">{value}</a> : value}
      </dd>
    </div>
  );
}

export function Contact({ t, locale }: { t: SiteCopy; locale: "ar" | "en" }) {
  const c = t.contact;
  const { email, phone, address } = COMPANY.contact;
  return (
    <section id="contact" aria-labelledby="contact-title" className="bg-night-gradient relative isolate overflow-hidden py-24 text-mist sm:py-36">
      <Container>
        <SectionMark index="06" label={c.label} />
        <div className="mt-14 grid gap-14 lg:grid-cols-12">
          <h2 id="contact-title" className="reveal site-display !text-[clamp(2.25rem,5.4vw,5rem)] lg:col-span-8">
            <span className="block">{c.line1}</span>
            <span className="block text-lilac">{c.line2}</span>
          </h2>
          <div className="reveal lg:col-span-4 lg:self-end">
            <p className="site-lead text-mist/75">{c.body}</p>
            {email && (
              <a href={`mailto:${email}`} className="mt-8 inline-flex h-12 items-center rounded-md bg-brand-violet px-6 text-sm font-medium text-mist transition-colors outline-none hover:bg-aubergine focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-2 focus-visible:ring-offset-night">
                {c.cta}
              </a>
            )}
          </div>
        </div>
        {/* only confirmed details are listed; nothing is shown in place of a missing one */}
        {(email || phone || address) && (
          <dl className="reveal mt-16 border-b border-mist/15 lg:w-2/3">
            {email && <Row label={c.email} value={email} href={`mailto:${email}`} />}
            {phone && <Row label={c.phone} value={phone} href={`tel:${phone}`} />}
            {address && <Row label={c.address} value={address[locale]} />}
          </dl>
        )}
      </Container>
    </section>
  );
}
