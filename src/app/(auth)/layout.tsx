import Link from "next/link";
import { OperaWordmark } from "@/components/brand/logo";
import { getI18n } from "@/lib/i18n/server";
import { LocaleSwitch } from "./locale-switch";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { m } = await getI18n();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between">
          <Link href="/" aria-label={m.auth.backToSite} className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-lilac focus-visible:ring-offset-4">
            <OperaWordmark className="h-6" />
          </Link>
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
          <p className="mt-4 max-w-md text-base text-lilac">{m.auth.workspaceNote}</p>
          <Link href="/" className="mt-10 inline-flex w-fit items-center gap-2 border-t border-mist/15 pt-6 text-sm text-mist/70 transition-colors hover:text-mist">
            {m.auth.backToSite}
          </Link>
        </div>
      </aside>
    </div>
  );
}
