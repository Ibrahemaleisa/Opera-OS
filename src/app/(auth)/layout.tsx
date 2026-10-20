import { OperaWordmark } from "@/components/brand/logo";
import { getI18n } from "@/lib/i18n/server";
import { LocaleSwitch } from "./locale-switch";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { m } = await getI18n();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between">
          <OperaWordmark className="h-6" />
          <LocaleSwitch />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">{children}</div>
        <p className="text-center text-[11px] text-muted-foreground">{m.auth.privacyNote}</p>
      </div>
      <aside className="bg-night-gradient relative hidden overflow-hidden text-mist lg:block">
        {/* the orbit: one cropped arc leaving the frame — the only arc in this composition */}
        <svg className="pointer-events-none absolute -end-[34%] -top-[30%] aspect-square w-[95%]" viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="48" fill="none" stroke="var(--mist)" strokeOpacity="0.8" strokeWidth="1.2" />
        </svg>
        <div className="relative flex h-full flex-col justify-end p-12">
          <p className="max-w-md text-4xl leading-[1.25] font-medium">{m.common.brandPromise}</p>
          <p className="mt-4 max-w-md text-base text-lilac">{m.auth.registerSubtitle}</p>
          <ul className="mt-10 grid max-w-md grid-cols-2 gap-x-6 gap-y-2 border-t border-mist/15 pt-6 text-sm text-mist/70">
            <li>{m.nav.delivery}</li>
            <li>{m.nav.digital}</li>
            <li>{m.nav.protocol}</li>
            <li>{m.nav.events}</li>
            <li>{m.nav.booths}</li>
            <li>{m.nav.finance}</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
