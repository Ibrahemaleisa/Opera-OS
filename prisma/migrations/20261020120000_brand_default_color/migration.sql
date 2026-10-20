-- Opera brand: new organisations default to Opera Violet; organisations still on the old
-- untouched default move with it (a colour an agency chose itself is left alone).
ALTER TABLE "Organization" ALTER COLUMN "brandColor" SET DEFAULT '#64228A';
UPDATE "Organization" SET "brandColor" = '#64228A' WHERE "brandColor" = '#0F5E57';
