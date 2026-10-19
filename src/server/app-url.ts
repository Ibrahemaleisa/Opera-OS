/** Public base URL for links in messages (RSVP, invitations). On Vercel falls back to the production domain. */
export function appBaseUrl(): string {
  const explicit = process.env.APP_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return (explicit || (vercel ? `https://${vercel}` : "http://localhost:3000")).replace(/\/$/, "");
}
