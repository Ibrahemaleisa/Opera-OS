/**
 * Photographs from Opera's own projects, under /public/site/field/. Captions describe only what
 * the photo shows: no client names, figures or claims beyond it. Named case studies go in work.ts
 * once the project and the client's permission are confirmed.
 */
import type { CapabilityKey } from "./work";

type L = { ar: string; en: string };

export interface FieldPhoto {
  src: string;
  alt: L;
  caption: L;
  field?: CapabilityKey;
  /** CSS object-position: which part of the frame to keep when it is cropped to fit */
  focus?: string;
}

/** Behind the hero: the scale of a live exhibition floor. Decorative there, so no caption is read. */
export const HERO_PHOTO: FieldPhoto = {
  src: "/site/field/exhibition-floor.jpg",
  alt: { ar: "", en: "" },
  caption: { ar: "", en: "" },
  focus: "50% 64%",
};

/** One project, two moments: the build and the day itself, in the same hall. */
export const BUILD_TO_DAY: { title: L; body: L; before: FieldPhoto; after: FieldPhoto } = {
  title: { ar: "مشروع واحد، من التركيب إلى يوم الحدث", en: "One project, from the build to the day itself" },
  body: { ar: "القاعة نفسها مرّتين: أثناء تركيب المسرح والإضاءة، ثم يوم استقبال الضيوف.", en: "The same hall, twice: while the stage and lighting go up, then on the day the guests arrive." },
  before: {
    src: "/site/field/stage-build.jpg",
    alt: { ar: "فنيون يركّبون المسرح ومنصّات الإضاءة في قاعة احتفالات قبل الافتتاح", en: "Technicians building the stage and lighting in a ballroom before opening" },
    caption: { ar: "أثناء التركيب", en: "The build" },
    focus: "50% 38%",
  },
  after: {
    src: "/site/field/event-day.jpg",
    alt: { ar: "القاعة نفسها يوم الحدث: الضيوف حول الطاولات أمام الشاشة الرئيسية", en: "The same hall on the day: guests at their tables before the main screen" },
    caption: { ar: "يوم الحدث", en: "On the day" },
  },
};

export const FIELD: FieldPhoto[] = [
  {
    src: "/site/field/stage-production.jpg",
    field: "events",
    alt: { ar: "مسرح مؤتمر بشاشة عرض كبيرة ومصوّر يصوّر الحدث", en: "A conference stage with a large screen and a camera operator filming" },
    caption: { ar: "المسرح والإنتاج المرئي", en: "Stage and visual production" },
    focus: "50% 45%",
  },
  {
    src: "/site/field/reception.jpg",
    field: "protocol",
    alt: { ar: "فريق الاستقبال يقف في بهو رخامي عند مدخل القاعة", en: "The reception team standing in a marble foyer at the hall entrance" },
    caption: { ar: "فريق الاستقبال عند مدخل القاعة", en: "The reception team at the hall entrance" },
    focus: "50% 55%",
  },
  {
    src: "/site/field/logistics.jpg",
    field: "projects",
    alt: { ar: "عمّال ينقلون مكوّنات من شاحنة برافعة شوكية إلى موقع العمل", en: "Crew moving components from a truck to site with a forklift" },
    caption: { ar: "من المستودع إلى الموقع", en: "From the warehouse to the site" },
    focus: "50% 70%",
  },
];

/** Behind the contact call: the people who would do the work. */
export const TEAM_PHOTO: FieldPhoto = {
  src: "/site/field/team.jpg",
  alt: { ar: "", en: "" },
  caption: { ar: "", en: "" },
  focus: "50% 45%",
};
