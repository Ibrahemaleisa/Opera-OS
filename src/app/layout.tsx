import "@fontsource-variable/instrument-sans";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { getI18n } from "@/lib/i18n/server";
import { Providers } from "./providers";

// imports, campaign launches and automations run in-request on serverless (JOBS_MODE=inline)
export const maxDuration = 300;

export const metadata: Metadata = {
  title: { default: "Operra Events OS", template: "%s · Operra" },
  description: "Operations platform for event, protocol and VIP invitation agencies",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f1" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0f12" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dir, calendar } = await getI18n();
  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body className="min-h-dvh text-sm">
        <Providers locale={locale} calendar={calendar}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
