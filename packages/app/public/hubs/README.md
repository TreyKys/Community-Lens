# Hub backdrop images

Backdrop art for the hub pages. Referenced from `lib/sportHubs.ts`
(`imageUrl` per hub, plus `FOOTBALL_HUB_ART`) and `lib/bbnTags.ts`
(`BBN_HUB_ART`).

    bbn.jpeg          Big Brother Naija   -> /bbn
    basketball.jpeg   Basketball          -> /basketball
    tennis.jpeg       Tennis              -> /tennis
    esports.jpeg      Esports             -> /esports
    fight.jpeg        Boxing & MMA        -> /fight
    football.jpeg     Football            -> /football

Currently 2752×1536 (≈16:9), ~2.5MB each. Generated with Google Flow — the
prompts are in `docs/BRAND-IMAGE-PROMPTS.md` if any need regenerating, so a
replacement matches the rest rather than drifting.

## Served without re-encoding

`ScrollFadeBackdrop` renders these with `unoptimized`, so Next.js passes the
exact bytes through — no re-compression, no per-device resizing. What is in
this folder is byte-for-byte what a user downloads.

That is deliberate, and it means file size is a manual concern. ~2.5MB is
acceptable for a full-bleed backdrop; if a future replacement lands much
heavier, that cost is paid on every first visit to the hub, and most of this
audience is on Nigerian mobile data.

## Replacing one

Keep the filename. Nothing else needs to change — the config points at these
paths, not at any particular format or size. If you switch format (e.g. to
`.webp`), update the matching `imageUrl` string in the two config files.

A missing or misnamed file degrades silently to the CSS gradient art underneath
rather than showing a broken frame, so verify on the page itself — a wrong
filename looks like "the image didn't change", not like an error.
