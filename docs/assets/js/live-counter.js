/* Reusable "Live now" presence counter for VoltScope dashboards.
 *
 * A tiny self-contained widget that shows how many people are viewing THIS
 * page right now (per-page, via a relay room) and degrades gracefully to a
 * local "1 here" label when no relay is reachable.
 *
 * Usage:
 *   import { initLiveCounter } from "./live-counter.js?v=...";
 *   initLiveCounter({ room: "finance", chipId: "live-chip", textId: "live-chip-text" });
 */

import { loadLiveConfig, createPresence } from "./live.js?v=20261105-1";

export function initLiveCounter({ room = "global", chipId = "live-chip", textId = "live-chip-text" } = {}) {
  const chip = document.getElementById(chipId);
  if (!chip) return null;
  const textEl = document.getElementById(textId) || chip;

  function render(presence) {
    const mode = presence?.mode || "off";
    const online = Number(presence?.online) || 0;
    if (mode === "relay") {
      chip.hidden = false;
      chip.dataset.mode = "relay";
      textEl.textContent = `${online} live`;
      chip.title = `${online} ${online === 1 ? "person" : "people"} viewing this page now — realtime relay`;
    } else if (mode === "local") {
      chip.hidden = false;
      chip.dataset.mode = "local";
      textEl.textContent = "1 here";
      chip.title = "Presence relay not configured — this count is this tab only";
    } else {
      chip.hidden = true;
    }
  }

  loadLiveConfig()
    .then((config) => {
      render({ mode: "local" }); // optimistic while the relay connects
      const feed = createPresence(config, { room, onUpdate: render });
      return feed;
    })
    .catch(() => {
      chip.hidden = true;
    });

  return { render };
}
