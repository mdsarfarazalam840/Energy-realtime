# VoltScope diagrams

Three diagrams, three jobs:

| File | Type | Purpose |
|---|---|---|
| `pipeline.html` | Static HTML + inline SVG | Editorial overview: market APIs to public dashboard |
| `architecture.html` | Interactive Archify artifact | Runtime components, guided views, trust boundary |
| `dataflow.html` | Interactive Archify artifact | Lineage from feeds through Kafka and Delta to the browser |

The gallery is `index.html`. GitHub Pages serves the folder at:

<https://mdsaifedu.eu.cc/Energy-realtime/diagrams/>

## Source specifications

The interactive diagrams are generated from JSON, not hand-edited:

```text
specs/architecture.json
specs/dataflow.json
```

Regenerate after editing a spec:

```bash
# From a checkout of tt-a1i/archify
node bin/archify.mjs validate architecture docs/diagrams/specs/architecture.json --quality showcase --json
node bin/archify.mjs deliver architecture docs/diagrams/specs/architecture.json docs/diagrams/architecture.html --quality showcase --json

node bin/archify.mjs validate dataflow docs/diagrams/specs/dataflow.json --quality showcase --json
node bin/archify.mjs deliver dataflow docs/diagrams/specs/dataflow.json docs/diagrams/dataflow.html --quality showcase --json
```

`deliver` writes a self-contained HTML file with theme switching, pan/zoom, search, focus, guided views, and export. The generated file is checked into `docs/` so GitHub Pages needs no build step.

## Editorial diagram

`pipeline.html` is hand-authored inline SVG. It follows the diagram-design rules:

- One primary path, left to right.
- Eight nodes, seven arrows, two focal nodes.
- 4px grid, 1px hairlines, 6px radius, no shadows.
- Mono only for technical sublabels; sans for names.
- Light warm paper with a restrained accent.

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
