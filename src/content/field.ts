/**
 * Photographs from Opera's own projects, under /public/site/field/. Captions describe only what
 * the photo shows: no client names, figures or claims beyond it. Named case studies go in work.ts
 * once the project and the client's permission are confirmed.
 */
import type { CapabilityKey } from "./work";

type L = { ar: string; en: string };

export interface FieldPhoto {
  src: string;
  width: number;
  height: number;
  alt: L;
  caption: L;
  field?: CapabilityKey;
}

/** One project, two moments: the build and the day itself (same hall). */
export const BUILD_TO_DAY: { title: L; before: FieldPhoto; after: FieldPhoto } = {
  title: { ar: "مشروع واحد، من التركيب إلى يوم الحدث", en: "One project, from the build to the day itself" },
  before: {
    src: "/site/field/stage-build.jpg",
    width: 736,
    height: 920,
    alt: { ar: "فنيون يركّبون المسرح ومنصّات الإضاءة في قاعة احتفالات قبل الافتتاح", en: "Technicians building the stage and lighting in a ballroom before opening" },
    caption: { ar: "قبل الافتتاح: تركيب المسرح والإضاءة", en: "Before opening: building the stage and lighting" },
  },
  after: {
    src: "/site/field/event-day.jpg",
    width: 736,
    height: 552,
    alt: { ar: "القاعة نفسها يوم الحدث: الضيوف حول الطاولات أمام الشاشة الرئيسية", en: "The same hall on the day: guests at their tables before the main screen" },
    caption: { ar: "يوم الحدث: القاعة نفسها وقد استقبلت ضيوفها", en: "On the day: the same hall, with its guests" },
  },
};

export const FIELD: FieldPhoto[] = [
  {
    src: "/site/field/exhibition-floor.jpg",
    width: 736,
    height: 920,
    field: "exhibitions",
    alt: { ar: "منظر علوي لأرض معرض مزدحمة بالزوار حول منصة دائرية وأجنحة", en: "Overhead view of a busy exhibition floor around a circular stage and booths" },
    caption: { ar: "أرض المعرض أثناء الزيارة", en: "The exhibition floor during visiting hours" },
  },
  {
    src: "/site/field/reception.jpg",
    width: 736,
    height: 920,
    field: "protocol",
    alt: { ar: "فريق الاستقبال يقف في بهو رخامي عند مدخل القاعة", en: "The reception team standing in a marble foyer at the hall entrance" },
    caption: { ar: "فريق الاستقبال عند مدخل القاعة", en: "The reception team at the hall entrance" },
  },
  {
    src: "/site/field/stage-production.jpg",
    width: 736,
    height: 920,
    field: "events",
    alt: { ar: "مسرح مؤتمر بشاشة عرض كبيرة ومصوّر يصوّر الحدث", en: "A conference stage with a large screen and a camera operator filming" },
    caption: { ar: "المسرح والإنتاج المرئي", en: "Stage and visual production" },
  },
  {
    src: "/site/field/logistics.jpg",
    width: 616,
    height: 770,
    field: "projects",
    alt: { ar: "عمّال ينقلون مكوّنات من شاحنة برافعة شوكية إلى موقع العمل", en: "Crew moving components from a truck to site with a forklift" },
    caption: { ar: "من المستودع إلى الموقع", en: "From the warehouse to the site" },
  },
];

export const TEAM_PHOTO: FieldPhoto = {
  src: "/site/field/team.jpg",
  width: 1320,
  height: 874,
  alt: { ar: "صورة جماعية لفريق العمل بالزي السعودي", en: "Group photo of the team in Saudi dress" },
  caption: { ar: "فريق واحد، وجهة واحدة.", en: "One team, one north star." },
};
