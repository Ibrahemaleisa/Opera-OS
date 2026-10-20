import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), geolocation=(self), microphone=()" },
  // Private operational data must never be indexed.
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // standalone bundle for the Docker image; Vercel uses its own output
  output: process.env.VERCEL ? undefined : "standalone",
  serverExternalPackages: ["@node-rs/argon2", "exceljs", "bullmq", "ioredis", "pg"],
  experimental: {
    serverActions: { bodySizeLimit: "30mb" },
    // forbidden() renders app/forbidden.tsx (see src/server/page-guard.ts)
    authInterrupts: true,
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // the corporate site is the only public, indexable surface (a later match overrides the key)
      { source: "/", headers: [{ key: "X-Robots-Tag", value: "index, follow" }] },
      { source: "/work/:path*", headers: [{ key: "X-Robots-Tag", value: "index, follow" }] },
    ];
  },
};

export default nextConfig;
