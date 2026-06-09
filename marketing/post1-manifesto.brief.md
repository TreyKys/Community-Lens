# Post 1 — The Manifesto Drop

**Format**: 1080×1920 vertical · 11s @ 30fps · IG Reels / TikTok / Shorts / X
**Source file**: `marketing/post1-manifesto.svg`
**Tone**: hard, kinetic, no faces, no fluff. The post you boost.

---

## How to wire it up

1. **Figma** → new file → 1080×1920 frame ("Instagram Story" preset) → drag the SVG in.
2. Open the **Jitter** plugin in Figma (or copy the frame and paste into Jitter directly).
3. In Jitter you'll see every `g id="…"` from the SVG as a named layer. **Don't rename them** — the timeline below references them.
4. Audio: any **130–150 BPM Afrobeats / log drum** hook works. Suggested cuts: Asake "Lonely At The Top" (intro), Odumodu Blvck "Declan Rice" (drop), Rema "Charm" (drop). Cut your hits to the kick on every keyframe transition.

---

## Timeline (keyframe by keyframe)

Each row is one Jitter keyframe. **Hold time** = how long the frame holds before the next transition starts. **Trans** = transition style to use in Jitter's Easing menu.

| # | Time | Hold | Visible layers | Action | Trans |
|---|------|------|----------------|--------|-------|
| 0 | 0.00s | 0.4s | `01_BG`, `02_Sweep_TL` (opacity 0 → 60%), `03_Sweep_BR` (opacity 0 → 50%) | Sweeps fade in from black. Logo / text layers all hidden. | Smooth |
| 1 | 0.40s | 1.2s | + `04_Scene1_SmartMoney` | "SMART MONEY DOESN'T GUESS." snaps in. Try **Anticipate** with a slight `scale: 1.04 → 1.00` overshoot for the punch. | Anticipate |
| 2 | 1.60s | 1.0s | swap `04 → 05_Scene2_TakesPositions` | Hide `04`, show `05`. "IT TAKES **POSITIONS**." — emerald word slightly larger and lands a beat after "IT TAKES". For extra kick, mask-wipe the emerald word left → right. | Snappy |
| 3 | 2.60s | 0.30s | swap `05 → 06_Football` | First category. Hard cut. | None (cut) |
| 4 | 2.90s | 0.30s | swap `06 → 07_Politics` | Hard cut. | None (cut) |
| 5 | 3.20s | 0.30s | swap `07 → 08_PopCulture` | Hard cut. | None (cut) |
| 6 | 3.50s | 0.70s | swap `08 → 09_Economy` | Hard cut, hold longer — this one's emerald, lands the list. | None (cut) |
| 7 | 4.20s | 1.4s | swap `09 → 10_InstantSettlement` | "INSTANT NAIRA / **SETTLEMENT**." Two-stage reveal — top line first, emerald word in 200ms later. | Smooth |
| 8 | 5.60s | 1.4s | swap `10 → 11_SealedPolygon` | "SEALED ON / **POLYGON**." Same two-stage pattern. | Smooth |
| 9 | 7.00s | 2.0s | swap `11 → 12_Scene6_Logo` | Logo lockup. Diamond mark scales from 0.6 → 1.0 with bounce. "OPINIONS.NG" text mask-wipes left → right. Tagline fades in 300ms after the logo lands. | Bouncy |
| 10 | 9.00s | 2.0s | + `13_LiveBadge` | LIVE pill slides up from y +60 → 0 with a small overshoot. The pulse circle is baked into the SVG (`<animate>`) — Jitter may strip it; if so, add a 1.4s opacity loop on the green circle. | Anticipate |
| 11 | 11.00s | end | hold | Final frame holds for ~0.5s on whatever platform end-card you use. | — |

### Why this beat structure

- **0 → 1.6s**: setup. The viewer's thumb is hovering — you have one beat to earn the watch. "Smart money doesn't guess" is the contrarian frame, lands immediately.
- **1.6 → 2.6s**: payoff. "Positions" is the wedge word against the betting category. Emerald = brand colour = takeaway.
- **2.6 → 4.2s**: the staccato list. 0.3s per category is *fast* — TikTok pacing. Don't let it linger; the speed is the point.
- **4.2 → 7.0s**: proof points. Pace slows. This is the "okay, why should I trust this" beat.
- **7.0 → end**: brand. Logo + LIVE pill. Sticky end frame, no CTA text needed (the link goes in caption / bio).

---

## Pace check

If you watch the export and it feels rushed, the fix is **always** to lengthen scenes 7 + 8 (the proof points), never to lengthen scenes 3–6 (the categories — they're meant to feel like a hook). If it feels slow, cut 0.2s off scenes 1, 2, and 9.

## Caption (drop alongside the post)

> The market just opened. Pick a side.
> opinions.ng 🇳🇬

## First-comment (X) / pinned-comment (IG)

> First call is on the house — if your first prediction loses, we refund it. Link in bio.

This double-taps the conversion mechanic *after* the brand impression lands. Don't put it on the video itself.
