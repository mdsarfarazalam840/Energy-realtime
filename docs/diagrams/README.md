# VoltScope diagrams

Three diagrams, three jobs:

| File | Type | Purpose |
|---|---|---|
| `pipeline.html` | Static HTML + inline SVG | Editorial overview: market APIs to public dashboard |
| `architecture.html` | Interactive Archify artifact | Runtime components, live lane, guided views, trust boundary |
| `dataflow.html` | Interactive Archify artifact | Lineage from feeds through Kafka and Delta to the shard and live-tail artifacts |

The gallery is `index.html`. GitHub Pages serves the folder at:

<https://mdsaifedu.eu.cc/Energy-realtime/diagrams/>

## Source specifications

The interactive diagrams are generated from JSON, not hand-edited:

```text
specs/architecture.json    17 components, 18 connections, 2 boundaries, 4 views
specs/dataflow.json        12 nodes, 11 flows, 5 stages, 3 views
```

Regenerate after editing a spec with Archify 3.2:

```bash
# From a checkout of tt-a1i/archify
node archify/bin/archify.mjs finalize architecture docs/diagrams/specs/architecture.json docs/diagrams/architecture.html --quality showcase --json
node archify/bin/archify.mjs finalize dataflow docs/diagrams/specs/dataflow.json docs/diagrams/dataflow.html --quality showcase --json
```

`finalize` runs validate, deliver, strict provenance check, and the browser gate, then writes a self-contained HTML file with theme switching, pan/zoom, search, focus, guided views, and export. The generated file is checked into `docs/` so GitHub Pages needs no build step.

Do not edit the generated HTML by hand. Edit the spec and rerun the same command.

## Editorial diagram

`pipeline.html` is hand-authored inline SVG. It follows the diagram-design rules:

- One primary path, left to right.
- Seven nodes, six arrows, one focal node and one accent family.
- 4px grid, 1px hairlines, 6px radius, no shadows.
- Mono only for technical sublabels; sans for names.
- Light warm paper with a restrained accent.
- A secondary freshness rail carries the five-minute lane, presence, and trust notes without adding a second path.

No external fonts, scripts, or images are required. The page is safe to open from `file://`, but the links to other diagrams are relative.

## Preview images

`../assets/diagrams/*.png` are screenshots used by the root README and the gallery. They are generated artifacts, not sources. Update them when the diagrams change:

```powershell
chrome --headless --disable-gpu --no-sandbox --hide-scrollbars `
  --user-data-dir="$env:TEMP\chrome-diagram" `
  --window-size=1440,900 `
  --screenshot="docs/assets/diagrams/architecture-preview.png" `
  "http://localhost:8000/diagrams/architecture.html"
```

Serve the site first:

```bash
python -m http.server 8000 --directory docs
```

## Accessibility

- Every SVG has `role="img"` and a resolving `aria-labelledby`.
- `<title>` and `<desc>` are the first children of the SVG.
- The editorial diagram uses system font fallbacks, so it renders offline.
- The Archify viewer provides its own keyboard and focus handling.
