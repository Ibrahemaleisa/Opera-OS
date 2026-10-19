import { getI18n } from "@/lib/i18n/server";
import { LocaleSwitch } from "./locale-switch";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { m } = await getI18n();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">O</span>
            <span className="text-sm font-semibold">{m.common.appName}</span>
          </div>
          <LocaleSwitch />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">{children}</div>
        <p className="text-center text-[11px] text-muted-foreground">{m.auth.privacyNote}</p>
      </div>
      <aside className="relative hidden overflow-hidden bg-[#0f1a1c] text-white lg:block">
        <svg className="absolute inset-0 h-full w-full opacity-[0.07]" aria-hidden>
          <defs>
            <pattern id="geo" width="56" height="56" patternUnits="userSpaceOnUse">
              <path d="M28 0 L56 28 L28 56 L0 28 Z M28 10 L46 28 L28 46 L10 28 Z" fill="none" stroke="#fff" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#geo)" />
        </svg>
        <div className="relative flex h-full flex-col justify-end p-12">
          <div className="mb-6 h-1 w-14 rounded-full bg-[#c9a46a]" />
          <h2 className="max-w-md text-3xl leading-snug font-semibold">{m.auth.registerSubtitle}</h2>
          <ul className="mt-8 grid max-w-md grid-cols-2 gap-x-6 gap-y-3 text-sm text-white/75">
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
