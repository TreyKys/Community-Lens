# Hub backdrop images — Google Flow prompts

Generation prompts for the hub backdrops (`/bbn`, `/basketball`, `/tennis`,
`/esports`, `/fight`, `/football`). Every colour below is taken from the live
theme tokens in `app/globals.css` and the OG card constants in
`app/api/open-card/[id]/route.tsx` — not invented, so the art matches the
product instead of sitting next to it.

---

## Read this first — two things that will bite you

**1. AI generators cannot reliably render the logo.**

The Opinions.ng mark is the letterform `O/N` in black on an emerald gradient
square. Image models garble short text almost every time — you will get `0/N`,
`ON`, `O\N`, `OM`, or an invented glyph. On a betting site a mangled logo reads
as a scam signal, so **do not ship a generated logo.**

Two ways round it, in order of preference:

- **Preferred — generate a clean centre.** Use the prompts below as written:
  they describe a *glowing emerald focal point* at centre, not lettering. The
  app already renders the real logo as live DOM. You get a perfect mark on top
  of generated art.
- **If you want the logo baked in** — generate with the centre clear, then
  composite the real `O/N` mark in Figma/Photoshop afterwards. Never let the
  model draw it.

Every prompt ends with a `no text, no letters, no words, no logos, no
watermarks` instruction for exactly this reason. Leave it in.

**2. These are backdrops — content sits on top of them.**

The image fades out as the user scrolls (`ScrollFadeBackdrop`). Market cards,
headings and prices render over the top third and middle. So the art must:

- be **darkest at the bottom and edges**, brightest in the upper-middle;
- have **no fine detail in the lower two-thirds** — that's where the cards go;
- read at a glance, because it is never the subject of attention.

A busy, evenly-lit photo will make text unreadable and the page feel cluttered.
The prompts below all specify this falloff.

---

## The shared style block

Paste this into **every** prompt, after the subject description. This is what
makes six separate images look like one product.

```
Style: ultra-realistic cinematic photography, 8K, wide landscape.
Colour grade: deep near-black background (#060C09) with a green tint,
lit almost entirely by neon emerald (#1BCA79) and bright mint accents
(#34D399). Cool, high-contrast, moody night atmosphere — like a stadium
or arena lit only by emerald LED strips. Subtle volumetric light haze.
Highlights bloom slightly. Fine film grain.
Composition: subject in the upper-middle third. Strong vignette — the
frame falls off to near-black at all four edges and especially along the
bottom third, which must stay dark, clean and almost empty. A soft
emerald glow sits at the exact centre of the frame, unobstructed, like
light source waiting behind something.
Negative: no text, no letters, no words, no numbers, no logos, no
watermarks, no brand marks, no people's faces in focus, no busy detail
in the lower half, no warm orange or yellow lighting, no daylight.
```

**Aspect ratio:** 16:9
**Resolution:** 3840 × 2160 (4K UHD)
**Format:** WebP, full quality — see below

---

## Per-hub prompts

### Big Brother Naija — `/bbn`

> A vast dark reality-TV house interior at night, seen wide: a curved modular
> lounge, glossy floor reflecting light, a wall of dim monitors far in the
> background. Everything is lit by emerald-green neon strip lighting running
> along the ceiling edges and floor line. In the far upper-middle distance, a
> single large circular light fixture glows like a watching eye. Empty room,
> nobody present. Reflections of green light pooling on the polished floor.

*Note: keep this generic. Do not prompt for the actual Big Brother Naija set,
logo, eye mark or house — that artwork is Multichoice / Africa Magic property,
and using it implies an endorsement this site does not have.*

### Basketball — `/basketball`

> A professional indoor basketball arena at night, shot wide from the baseline.
> Polished hardwood court reflecting emerald-green light, court lines glowing
> faintly. A single basketball resting at centre court. Empty stands receding
> into darkness. Overhead arena rigs throw narrow emerald beams down through a
> light haze onto the hardwood. Dramatic, silent, moments before tip-off.

### Tennis — `/tennis`

> A floodlit tennis court at night, wide angle from behind the baseline. The
> net stretches across the middle distance, lit from the side so the mesh
> catches emerald-green light. Court surface deep and dark, service lines
> glowing faint mint. A single tennis ball mid-bounce near centre. Empty
> stadium seating dissolving into black. Fine mist in the floodlight beams.

### Esports — `/esports`

> A darkened esports arena, wide shot down an empty competition stage. Two rows
> of gaming stations face each other, their monitors dark, edge-lit by emerald
> RGB strips. A huge blank stage screen looms in the upper background, glowing
> soft green. Cables and desk edges catch neon rim-light. Haze in the air
> catching beams from overhead rigs. Nobody present, moments before a final.

### Boxing & MMA — `/fight`

> A boxing ring in a dark arena, viewed wide from ringside. Empty ring, canvas
> stretching across the lower-middle frame, ropes catching hard emerald rim
> light. A single overhead light rig hangs above the ring centre, throwing a
> cone of green-tinted light down through heavy atmospheric haze. Corner posts
> silhouetted. Empty seats vanish into total black.

### Football — `/football` *(optional — has no backdrop yet)*

> A floodlit football stadium at night, wide from the touchline. Pitch stripes
> receding into the distance, grass lit cold emerald-green rather than natural
> green. A single ball on the centre spot. Empty stands rising into darkness,
> a few distant floodlight flares. Light mist drifting across the pitch.

---

## Where the files go

**The config is already wired.** All six `imageUrl` values are set. The only
remaining step is dropping the files into `packages/app/public/hubs/` with
these exact names:

    bbn.jpeg  basketball.jpeg  tennis.jpeg  esports.jpeg  fight.jpeg  football.jpeg

If your exports are `.png` or `.jpg`, either convert them or change the
extension in `lib/sportHubs.ts` / `lib/bbnTags.ts` — the path string is the
only thing that has to match.

A missing or misnamed file degrades silently to the CSS gradient art, so check
the page rather than the console — a wrong filename looks like "the image
didn't change", not like an error.

## No compression is applied

`ScrollFadeBackdrop` renders with `unoptimized`, so Next.js passes the exact
bytes through — no re-encode, no per-device resizing. What you put in
`public/hubs/` is byte-for-byte what a user downloads.

The tradeoff worth knowing: that also means a phone gets the full 4K file. A
lossless 4K export can run 8-12MB, paid on the first visit to each hub, and
most of this audience is on Nigerian mobile data. If any file lands very large,
lossless WebP usually saves 30-50% over PNG at identical pixels — that
compresses the *file* without touching the *image*, which is the version of
compression worth doing.

---

## Checking one before you do all six

Generate **basketball first** and view it at `/basketball` on a phone. Look for:

- Can you read the market card text over the top third? If not, the image is
  too bright — regenerate with `much darker, heavier vignette` added.
- Does it still look intentional once faded at scroll position ~400px?
- Does it feel like the same product as `/bbn` next to it?

Get one right, then reuse the exact style block for the rest.
