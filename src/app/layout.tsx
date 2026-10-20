import "./globals.css";
import type { Metadata, Viewport } from "next";
import { getI18n } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";
import { arabic, jost } from "./fonts";
import { Providers } from "./providers";

// imports, campaign launches and automations run in-request on serverless (JOBS_MODE=inline)
export const maxDuration = 300;

export const metadata: Metadata = {
  title: { default: "Opera", template: "%s · Opera" },
  description: "Operations platform for event, protocol and VIP invitation agencies",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f2f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0918" },
  ],
  width: "device-width",
  initialScale: 1,
};

// Thmanyah Sans is self-hosted only when its licensed files are installed (public/fonts/thmanyah)
const thmanyah = process.env.NEXT_PUBLIC_THMANYAH_FONT === "1";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dir, calendar } = await getI18n();
  return (
    <html lang={locale} dir={dir} className={cn(jost.variable, arabic.variable)} suppressHydrationWarning>
      <head>
        {/* a static file outside the bundle, so it can be switched on without the font files in the repo */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        {thmanyah && <link rel="stylesheet" href="/fonts/thmanyah/thmanyah.css" />}
      </head>
      <body className="min-h-dvh text-sm">
        <Providers locale={locale} calendar={calendar}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
