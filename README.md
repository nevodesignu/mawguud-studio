# Mawguud Studio

In-house sign design studio for [Mawguud](https://mawguud.com) — custom apartment & villa signs, laser-cut acrylic.

A mini-Illustrator built for one job: type a customer's name (Arabic first-class), lay it out on a sign template, and turn it into a machine-ready cut file in one click.

## The two phases

1. **Design** — pick a template (Left|Right, Up|Down, Vertical, Square), type the text, drag / scale / center it. Arabic shapes correctly (real HarfBuzz shaping — the same engine browsers use), mixed lines like `فيلا 50` order correctly. Export a clean black & white **client preview PNG** for WhatsApp approval.
2. **Finalize** — one click:
   - text → outlines (no fonts needed downstream)
   - overlapping Arabic joins welded into single shapes
   - **every enclosed hole detected automatically** (any script, any font) and given one **bridge** so the counter doesn't fall out of the panel when the laser cuts
   - bridges are draggable if you want them elsewhere; holes too small to bridge are flagged
   - export a **PDF-compatible `.ai`** at exact 1:1 scale (a 40×25 cm sign is a 40×25 cm page), plus `.pdf` / production `.svg`

Cut-file conventions: hairline red strokes for cut lines (panel outline + mounting holes), black fill + hairline red stroke for letter shapes.

## Run it

```bash
npm install
npm run dev
```

Headless pipeline test (writes `out/smoke.ai` + `out/smoke.pdf`):

```bash
npm run smoke
```

## Architecture

| Layer | What it does |
| --- | --- |
| `src/shaping/` | HarfBuzz WASM shaping, bidi-lite run splitting, glyph outlines |
| `src/geom/` | curve flattening, boolean welding, hole detection, bridge placement |
| `src/export/` | 1:1-mm PDF-compatible `.ai` writer, production SVG, client PNG |
| `src/fonts/` | built-in OFL fonts + user font upload (IndexedDB) |
| `src/store/` | design document, undo/redo, autosave, finalize orchestration |
| `src/ui/` | canvas editor (drag, snap, guides, resize), panels, finalize view |

Designs autosave to the browser (IndexedDB). Fonts you upload stay on your machine.

## Bundled fonts

Amiri Bold, Tajawal Bold, Almarai Bold, Poppins Bold — all under the SIL Open Font License (see `public/fonts/OFL-*.txt`). Upload your own production fonts in the **Fonts** tab (`.ttf`/`.otf`; Arabic fonts must be proper OpenType fonts).

## Roadmap

- Import real Mawguud `.ai` templates as presets
- Bridge spec calibrated against a real production file
- Engrave layer support and per-layer export
- Order intake → prefilled design
