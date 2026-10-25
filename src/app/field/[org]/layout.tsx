import type { Viewport } from "next";
import { getI18n } from "@/lib/i18n/server";
import { requirePageContext } from "@/server/request";

export const viewport: Viewport = { themeColor: "#1e0d33", width: "device-width", initialScale: 1, viewportFit: "cover" };
export const metadata = { title: "Field", manifest: "/manifest.webmanifest" };

export default async function FieldLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org } = await params;
  await requirePageContext(org, "field");
  await getI18n();
  return <div className="min-h-dvh bg-background pb-[env(safe-area-inset-bottom)]">{children}</div>;
}
