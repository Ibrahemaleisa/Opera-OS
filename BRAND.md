# Opera brand in the product

How the Opera Brand Guidelines v1.2 (2026) are applied in this codebase. The guidelines
document is the source of truth; this file maps its rules to code.

## Where things live

| Rule (guidelines page) | Implementation |
|---|---|
| Palette and proportions (10–11) | Tokens in `src/app/globals.css` (`--plum`, `--night`, `--brand-violet`, `--mist`, `--aubergine`, `--lilac`, `--ink`, `--slate`, functional `--success`/`--warning`/`--danger`). Every text pair meets WCAG AA; the dark theme uses lilac‑violet for text accents because violet on dark fails contrast. |
| Typefaces (12–13, 30) | `src/app/fonts.ts`: Jost leads the stack in both locales (Latin words and Western digits), Arabic falls through to Thmanyah Sans / the stand‑in, scaled 115%. Arabic line height 1.6 (headings 1.25), Latin 1.5 (1.15). Headings are Medium (500); Latin headings track −1%; Latin labels are uppercase +8% (`.eyebrow`). |
| Thmanyah Sans | Not bundled (licence forbids redistribution). See `public/fonts/thmanyah/README.md` to enable it with `NEXT_PUBLIC_THMANYAH_FONT=1`. |
| Logo and symbol (4–9) | `src/components/brand/logo.tsx` + generated `logo-paths.ts`: ring thickness x = 0.107 × diameter, dot 2x centred on the ring, 45° gap at 11 o'clock, "pera" from Jost Regular outlines. Never mirrored in RTL. The product uses the Latin wordmark in both locales (the guidelines' default for product). Replace with official artwork files when available. |
| App icon (16) | `public/icon.svg`, `icon-192/512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `favicon.ico`: night gradient, symbol at 56%, 22.5% corner radius. |
| Graphic elements (14) | The orbit (one cropped arc) on the sign‑in panel; the dot marks the current item in the sidebar. |
| Icons (15) | Lucide at 1.75 stroke with round caps (`svg.lucide` in `globals.css`); Ink/Mist only, the active item highlighted. |
| Status ring (31) | `src/components/brand/status-ring.tsx`: not started, in progress, awaiting approval, late, paused, complete (the ring closes into the symbol). Always shown with text. |
| Charts (32) | Neutral bars on the ground colour (`--chart-bar`), categories violet / ochre / steel / slate, no shadows or 3D. |
| Components (21, 33) | One violet primary button per screen; secondary buttons outlined in lilac; focus = lilac ring offset 2px; inputs turn violet on focus and red on error; 8px radius for elements, 12px for containers; Plum toast with the ring for completed actions. |
| Motion (25) | 150–250ms, 300ms max, ease‑out `cubic-bezier(0.23, 1, 0.32, 1)`; opacity/translate only; `prefers-reduced-motion` removes movement. |
| Voice (22) | Error copy says what happened and what to do next; no exclamation marks. |

Agencies (tenants) keep their own brand colour for their mark, client portal and RSVP
page; Opera's identity frames the product around it.

## Known gaps

* Thmanyah Sans files and the official logo artwork are not in the repository.
* Icons are Lucide, not a custom set drawn with the open‑circle signature.
* Starter templates use the brand categories for workstream colours, but they are copied into an organisation when it is created: existing organisations, and projects already created from them, keep the earlier colours until a template is edited.
