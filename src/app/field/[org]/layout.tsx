import type { Viewport } from "next";
import { redirect } from "next/navigation";
import { getI18n } from "@/lib/i18n/server";
import { requirePageContext } from "@/server/request";
import { can } from "@/server/authz/policy";

export const viewport: Viewport = { themeColor: "#1e0d33", width: "device-width", initialScale: 1, maximumScale: 1, viewportFit: "cover" };
export const metadata = { title: "Field", manifest: "/manifest.webmanifest" };

export default async function FieldLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requirePageContext(org);
  if (!can(ctx, "delivery.field")) redirect(`/o/${org}`);
  await getI18n();
  return <div className="min-h-dvh bg-background pb-[env(safe-area-inset-bottom)]">{children}</div>;
}
