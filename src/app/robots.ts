import type { MetadataRoute } from "next";
import { appBaseUrl } from "@/server/app-url";

// Only the corporate site is public; the operations workspace stays out of search engines.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/$", "/work/"], disallow: ["/o/", "/portal/", "/vendor/", "/field/", "/rsvp/", "/api/", "/account", "/login", "/register", "/invite/", "/select-org"] }],
    sitemap: `${appBaseUrl()}/sitemap.xml`,
  };
}
