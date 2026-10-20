# Thmanyah Sans (Arabic brand typeface)

The Opera brand guidelines set Arabic in **Thmanyah Sans**. Its licence permits use in websites and
applications but forbids redistributing or re-hosting the files for download, so they are **not**
committed here. Until they are installed the app uses IBM Plex Sans Arabic, scaled the same way.

To enable it:

1. Download the font from https://thmanyah.com (the files arrive by email).
2. Put the files in this folder with these names (`.woff2` preferred, `.otf` also works):
   `ThmanyahSans-Light`, `ThmanyahSans-Regular`, `ThmanyahSans-Medium`, `ThmanyahSans-Bold`,
   `ThmanyahSans-Black`.
3. Set `NEXT_PUBLIC_THMANYAH_FONT=1` (locally in `.env`, on Vercel in Project → Environment
   Variables) and rebuild.

`thmanyah.css` declares the faces at 115% size (Arabic is set 15% larger than adjacent Latin) and
puts Thmanyah Sans ahead of the stand-in. Check the licence terms on thmanyah.com before deploying.
