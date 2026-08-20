# Hub backdrop images

Drop the generated hub art here, named EXACTLY as below. The filenames are
referenced from `lib/sportHubs.ts` and `lib/bbnTags.ts`.

    bbn.webp          Big Brother Naija   -> /bbn
    basketball.webp   Basketball          -> /basketball
    tennis.webp       Tennis              -> /tennis
    esports.webp      Esports             -> /esports
    fight.webp        Boxing & MMA        -> /fight
    football.webp     Football            -> /football

## Format

`.webp` is what the config expects. If your files are `.png` or `.jpg`, either
convert them or change the extension in the two config files — the path string
is the only thing that needs to match.

## These are served UNCOMPRESSED, on purpose

`ScrollFadeBackdrop` renders them with `unoptimized`, so Next.js passes the
exact bytes through with no re-encode and no per-device resizing. Whatever you
put here is what a user downloads.

That preserves quality exactly, and it means FILE SIZE IS ON YOU. A 4K
lossless export can run 8-12MB, and this is a backdrop on a site whose users
are largely on Nigerian mobile data — that cost is paid on every first visit
to the hub. Worth checking each file's size before shipping. If any come out
very large, lossless WebP typically saves 30-50% over PNG with zero quality
loss, which is compression of the file but not of the image.

## Missing files are safe

A missing or broken path degrades silently to the CSS gradient art underneath
(`ScrollFadeBackdrop` catches the load error). So a wrong filename shows the
old look rather than a broken frame — check the page, not just the console.
