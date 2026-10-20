/**
 * Selected work. Publish only real, approved projects. Images live under /public/work/<slug>/.
 * The section and the /work/<slug> pages render from this list; while it is empty the site
 * shows a "being prepared" state instead of invented case studies.
 */
export type CapabilityKey = "events" | "exhibitions" | "invitations" | "protocol" | "projects" | "services";

type L = { ar: string; en: string };

export interface WorkProject {
  slug: string;
  title: L;
  category: CapabilityKey;
  year: number;
  location?: L;
  client?: L;
  summary: L;
  cover: { src: string; alt: L };
  sections?: { heading: L; body: L }[];
  gallery?: { src: string; alt: L }[];
}

export const WORK: WorkProject[] = [];

export function findProject(slug: string) {
  return WORK.find((p) => p.slug === slug) ?? null;
}
