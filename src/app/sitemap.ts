import type { MetadataRoute } from "next";
import { WORK } from "@/content/work";
import { appBaseUrl } from "@/server/app-url";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = appBaseUrl();
  return [{ url: `${base}/`, changeFrequency: "monthly", priority: 1 }, ...WORK.map((p) => ({ url: `${base}/work/${p.slug}`, changeFrequency: "yearly" as const, priority: 0.7 }))];
}
