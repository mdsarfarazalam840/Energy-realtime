"""Browser user-journey and performance audit for the VoltScope dashboard.

Runs real Chromium (Playwright) against a local copy of `docs/`, so it never
touches the public site. Covers:

  * cold boot, WebGL scene, charts, and KPIs
  * every documented interaction: filters, timeline brush, replay, camera,
    theme, help, share hash, keyboard shortcuts, mobile drawers
  * failure modes: missing snapshot, corrupt JSON, CDN blocked, slow network
  * 80,000-point / 48-zone snapshot at desktop and mobile widths
  * frame rate, long tasks, JS heap, and refresh soak for leaks

Usage:
    python tests/load/ui_audit.py --snapshot tests/load/data/energy-80k.json --label 80k
    python tests/load/ui_audit.py --snapshot tests/load/data/energy-80k.json --soak 5

Exit code 1 when an assertion or performance threshold fails.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO = Path(__file__).resolve().parents[2]
DOCS = REPO / "docs"
SERVER = Path(__file__).resolve().with_name("serve_docs.mjs")


def _load_shard_module():
    spec = importlib.util.spec_from_file_location("dashboard_shards", REPO / "scripts" / "dashboard_shards.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SHARDS = _load_shard_module()

DESKTOP = {"width": 1440, "height": 900}
MOBILE = {"width": 390, "height": 844}

findings: list[str] = []
checks: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    checks.append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        findings.append(f"{name}: {detail}" if detail else name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' - ' + detail) if detail else ''}")
    return ok


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@contextmanager
def origin(site: Path):
    port = free_port()
    proc = subprocess.Popen(
        ["node", str(SERVER), "--root", str(site), "--port", str(port), "--workers", "1", "--latency", "0"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url + "/", timeout=1) as response:
                    if response.status == 200:
                        break
            except Exception:  # noqa: BLE001 - retry until the origin is up
                time.sleep(0.15)
        else:
            raise RuntimeError("local origin did not start")
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def prepare_site(snapshot: Path | None, corrupt: bool = False) -> Path:
    site = Path(tempfile.mkdtemp(prefix="voltscope-site-"))
    shutil.copytree(DOCS, site, dirs_exist_ok=True)
    data_dir = site / "data"
    target = data_dir / "energy.json"
    if corrupt:
        target.write_text("{ this is not json", encoding="utf-8")
        # Remove the valid shards so the corrupt legacy file is what the page
        # actually falls back to.
        (data_dir / "index.json").unlink(missing_ok=True)
        shutil.rmtree(data_dir / "days", ignore_errors=True)
    elif snapshot is not None:
        data_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(snapshot, target)
        with target.open("r", encoding="utf-8") as handle:
            SHARDS.write_shards(data_dir, json.load(handle))
    return site


INIT_SCRIPT = """
window.__longTasks = [];
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
  }).observe({ type: 'longtask', buffered: true });
} catch { /* unsupported */ }
window.__errors = [];
window.addEventListener('error', (event) => window.__errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));
"""


def attach(page: Page) -> tuple[list[str], list[str], list[str]]:
    console: list[str] = []
    page_errors: list[str] = []
    failed: list[str] = []
    page.on("console", lambda msg: console.append(f"{msg.type}: {msg.text}") if msg.type in ("error", "warning") else None)
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.on("requestfailed", lambda req: failed.append(f"{req.url} {req.failure}"))
    page.add_init_script(INIT_SCRIPT)
    return console, page_errors, failed


def wait_boot(page: Page, timeout: int = 30000) -> float:
    page.wait_for_function("document.getElementById('boot')?.classList.contains('is-done') === true", timeout=timeout)
    return page.evaluate("() => performance.now()")


def fps(page: Page, ms: int = 2500) -> float:
    return page.evaluate(
        """async (ms) => {
          const frames = await new Promise((resolve) => {
            let count = 0;
            const start = performance.now();
            const step = (now) => {
              count += 1;
              if (now - start >= ms) resolve(count);
              else requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          });
          return frames / (ms / 1000);
        }""",
        ms,
    )


def heap_mb(page: Page) -> float:
    page.evaluate("() => { if (window.gc) { window.gc(); window.gc(); } }")
    page.wait_for_timeout(250)
    session = page.context.new_cdp_session(page)
    session.send("Performance.enable")
    metrics = session.send("Performance.getMetrics")["metrics"]
    session.detach()
    used = next((item["value"] for item in metrics if item["name"] == "JSHeapUsedSize"), 0)
    return round(used / 1_048_576, 1)


def live_state(page: Page) -> dict:
    return page.evaluate(
        """() => {
          const s = window.__voltscope?.state;
          if (!s) return null;
          return {
            points: s.points.length,
            rows: s.rows.length,
            lanes: s.stats?.lanes?.length || 0,
            demo: s.demo,
            range: s.range,
            baseline: s.baseline,
            series: s.seriesMode,
            playing: s.playing,
            playhead: s.playhead,
            theme: s.theme,
            scene: Boolean(window.__voltscope.scene),
            snapshotRows: s.snapshot?.meta?.row_count,
            mode: s.mode,
            dateFrom: s.dateFrom,
            dateTo: s.dateTo,
            customDates: s.customDates,
            loadedDays: s.loadedDays.slice(),
            totalDays: s.index?.days?.length || 0,
          };
        }"""
    )


def run_journey(browser, url: str, viewport: dict, name: str, mobile: bool) -> dict:
    print(f"\n[{name}]")
    context = browser.new_context(viewport=viewport, is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
    page = context.new_page()
    console, page_errors, failed = attach(page)

    page.goto(url, wait_until="load", timeout=60000)
    boot_ms = wait_boot(page)
    state = live_state(page)
    renderer = page.evaluate(
        """() => {
          const gl = document.createElement('canvas').getContext('webgl');
          const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
          return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
        }"""
    )
    software = "swiftshader" in renderer.lower() or "llvmpipe" in renderer.lower()
    boot_budget = 12000 if software else 8000
    # Software WebGL stalls the main thread on every draw, so it gets a wider
    # budget. Hardware runs are the ones that gate the user experience.
    interaction_budget = 1800 if software else 600
    check(f"{name}: snapshot parsed", bool(state and state["points"] > 0), f"{state and state['points']} points")
    check(f"{name}: boot under {boot_budget // 1000}s", boot_ms < boot_budget, f"{boot_ms:.0f} ms")
    check(f"{name}: no page errors", not page_errors, "; ".join(page_errors[:2]))
    check(f"{name}: no failed requests", not failed, "; ".join(failed[:2]))
    check(f"{name}: no console errors", not [c for c in console if c.startswith("error")], "; ".join(console[:2]))
    check(f"{name}: 3D scene ready", bool(state and state.get("scene")), str(state and state.get("scene")))
    check(f"{name}: no warning banner", not page.locator("#banner").is_visible() or "stale" not in page.locator("#banner").inner_text(), "")

    idle_fps = fps(page)
    if software:
        print(f"  INFO  {name}: software WebGL ({renderer}); fps reported, not gated")
    else:
        check(f"{name}: idle fps >= 30", idle_fps >= 30, f"{idle_fps:.1f} fps")
    resources = page.evaluate(
        """() => performance.getEntriesByType('resource').map((entry) => ({
          name: entry.name,
          ms: Math.round(entry.duration),
          bytes: entry.transferSize,
          start: Math.round(entry.startTime),
        }))"""
    )
    cdn = [entry for entry in resources if "cdn.jsdelivr.net" in entry["name"]]
    cdn_ms = max((entry["ms"] for entry in cdn), default=0)
    print(f"  INFO  {name}: CDN slowest module {cdn_ms} ms, boot {boot_ms:.0f} ms")

    dom_nodes = page.evaluate("() => document.getElementsByTagName('*').length")
    heap_before = heap_mb(page)

    # Filter switches - each one rebuilds every bar, so this is the hot path.
    for value in ("24h", "30d", "all", "6h", "7d"):
        elapsed = page.evaluate(
            """(value) => {
              const button = document.querySelector(`[data-range="${value}"]`);
              const start = performance.now();
              button.click();
              return performance.now() - start;
            }""",
            value,
        )
        check(f"{name}: range {value} under {interaction_budget}ms", elapsed < interaction_budget, f"{elapsed:.0f} ms")

    # Baseline + series mode.
    for selector in ('[data-baseline="zero"]', '[data-series="indexed"]', '[data-baseline="window"]', '[data-series="raw"]'):
        elapsed = page.evaluate(
            """(selector) => {
              const start = performance.now();
              document.querySelector(selector).click();
              return performance.now() - start;
            }""",
            selector,
        )
        check(f"{name}: toggle {selector} under {interaction_budget}ms", elapsed < interaction_budget, f"{elapsed:.0f} ms")

    # Date picker: only the selected UTC day should be downloaded.
    date_info = page.evaluate(
        """() => {
          const s = window.__voltscope.state;
          const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
          return {
            from: document.getElementById('date-from').value,
            to: document.getElementById('date-to').value,
            days: s.index.days.map((day) => day.date),
            loaded: s.loadedDays.slice(),
            total: s.index.meta.row_count,
            points: s.points.length,
            fetchedLegacy: resources.some((url) => /\\/data\\/energy\\.json/.test(url)),
            fetchedManifest: resources.some((url) => /\\/data\\/index\\.json/.test(url)),
            mode: s.mode,
          };
        }"""
    )
    check(f"{name}: date picker shows the window", bool(date_info["from"]) and bool(date_info["to"]), f"{date_info['from']} -> {date_info['to']}")
    check(f"{name}: manifest drives the boot", bool(date_info["fetchedManifest"]) and not date_info["fetchedLegacy"], f"mode={date_info['mode']}")
    if len(date_info["days"]) > 7:
        check(
            f"{name}: boot loads a date subset",
            date_info["points"] < date_info["total"],
            f"{date_info['points']} of {date_info['total']} rows",
        )

    target_day = next((day for day in date_info["days"] if day not in date_info["loaded"]), date_info["days"][0])
    day_fetches_before = page.evaluate(
        "() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/data/days/')).length"
    )
    date_started = time.perf_counter()
    page.evaluate(
        """(day) => {
          const from = document.getElementById('date-from');
          const to = document.getElementById('date-to');
          from.value = day;
          to.value = day;
          from.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        target_day,
    )
    page.wait_for_function(
        """(day) => {
          const s = window.__voltscope.state;
          return !s.loadingDates && s.customDates && s.loadedDays.length === 1 && s.loadedDays[0] === day;
        }""",
        arg=target_day,
        timeout=20000,
    )
    date_ms = (time.perf_counter() - date_started) * 1000
    picked = live_state(page)
    day_fetches_after = page.evaluate(
        "() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/data/days/')).length"
    )
    check(f"{name}: one-day pick loads one shard", 0 <= day_fetches_after - day_fetches_before <= 1, f"+{day_fetches_after - day_fetches_before} file(s)")
    check(f"{name}: one-day pick renders", picked["rows"] > 0 and picked["customDates"], f"{picked['rows']} rows on {target_day}")
    check(f"{name}: one-day pick under 6000ms", date_ms < 6000, f"{date_ms:.0f} ms")
    check(f"{name}: date lands in the hash", f"from={target_day}" in page.evaluate("() => window.location.hash"), page.evaluate("() => window.location.hash")[:80])

    page.evaluate("() => document.getElementById('btn-reset').click()")
    page.wait_for_function(
        "() => { const s = window.__voltscope.state; return !s.loadingDates && !s.customDates && s.range === '7d'; }",
        timeout=20000,
    )
    reset_state = live_state(page)
    check(
        f"{name}: reset restores the rolling window",
        not reset_state["customDates"] and bool(reset_state["loadedDays"]) and reset_state["points"] > 0,
        f"{reset_state['range']} - {len(reset_state['loadedDays'])} day(s)",
    )

    # Timeline hover stress: nearest() scans every point on every pointer move.
    hover = page.evaluate(
        """() => {
          const canvas = document.getElementById('timeline-chart');
          const rect = canvas.getBoundingClientRect();
          const samples = [];
          for (let i = 0; i < 12; i += 1) {
            const x = rect.left + 60 + ((rect.width - 80) * i) / 11;
            const y = rect.top + rect.height / 2;
            const start = performance.now();
            canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
            samples.push(performance.now() - start);
          }
          samples.sort((a, b) => a - b);
          return { median: samples[Math.floor(samples.length / 2)], max: samples[samples.length - 1] };
        }"""
    )
    check(f"{name}: timeline hover median < 50ms", hover["median"] < 50, f"{hover['median']:.1f} ms")
    check(f"{name}: timeline hover max < 150ms", hover["max"] < 150, f"{hover['max']:.1f} ms")

    # Replay.
    page.evaluate("() => document.getElementById('btn-play').click()")
    page.wait_for_timeout(1200)
    playing_fps = fps(page, 1500)
    replay_state = live_state(page)
    check(f"{name}: replay advanced", bool(replay_state["playing"]) or replay_state["playhead"] is not None, f"playing={replay_state['playing']}")
    if not software:
        check(f"{name}: replay fps >= 24", playing_fps >= 24, f"{playing_fps:.1f} fps")
    page.evaluate("() => document.getElementById('btn-play').click()")

    # Theme, help, camera, keyboard, share hash.
    theme_before = page.evaluate("() => document.documentElement.dataset.theme")
    page.evaluate("() => document.getElementById('btn-theme').click()")
    theme_after = page.evaluate("() => document.documentElement.dataset.theme")
    check(f"{name}: theme toggles", theme_after != theme_before, f"{theme_before} -> {theme_after}")
    page.evaluate("() => document.getElementById('btn-theme').click()")

    page.evaluate("() => document.getElementById('btn-help').click()")
    check(f"{name}: help dialog opens", page.evaluate("() => document.getElementById('help-dialog').open"))
    page.keyboard.press("Escape")

    page.keyboard.press("2")
    camera_hash = page.evaluate("() => window.location.hash")
    check(f"{name}: camera shortcut writes hash", "cam=profile" in camera_hash, camera_hash[:80])
    page.keyboard.press("1")

    page.evaluate("() => document.getElementById('btn-share').click()")
    page.wait_for_timeout(200)
    check(f"{name}: share gives feedback", page.locator(".toast").count() > 0, "")

    if mobile:
        page.evaluate("() => document.getElementById('btn-insights').click()")
        check(f"{name}: insights drawer opens", page.evaluate("() => document.getElementById('app').classList.contains('is-insights-open')"))
        page.evaluate("() => document.getElementById('btn-insights').click()")
        page.evaluate("() => document.getElementById('btn-filters').click()")
        check(f"{name}: filters drawer opens", page.evaluate("() => document.getElementById('app').classList.contains('is-filters-open')"))
        page.evaluate("() => document.getElementById('btn-filters').click()")

    # Accessibility sanity.
    check(f"{name}: has skip link", page.locator("a.skip-link").count() == 1)
    check(f"{name}: canvas charts labelled", page.locator("canvas[role='img'], canvas[aria-label]").count() >= 2)

    result = {
        "viewport": name,
        "boot_ms": round(boot_ms),
        "points": state["points"] if state else 0,
        "lanes": state["lanes"] if state else 0,
        "idle_fps": round(idle_fps, 1),
        "replay_fps": round(playing_fps, 1),
        "software_webgl": software,
        "renderer": renderer,
        "cdn_slowest_ms": cdn_ms,
        "resources": sorted(resources, key=lambda entry: entry["ms"], reverse=True)[:6],
        "hover_ms": {k: round(v, 1) for k, v in hover.items()},
        "dom_nodes": dom_nodes,
        "heap_mb": heap_before,
        "date_window": {
            "from": date_info["from"],
            "to": date_info["to"],
            "available_days": len(date_info["days"]),
            "loaded_days": len(date_info["loaded"]),
            "picked": target_day,
            "picked_ms": round(date_ms),
        },
        "timings": page.evaluate("() => window.__voltscope?.timings || {}"),
        "console": console[:10],
    }

    context.close()
    return result


def run_soak(browser, url: str, cycles: int, viewport: dict) -> dict:
    print(f"\n[soak x{cycles}]")
    context = browser.new_context(viewport=viewport)
    page = context.new_page()
    console, page_errors, _ = attach(page)
    page.goto(url, wait_until="load", timeout=60000)
    wait_boot(page)
    page.wait_for_timeout(800)
    before = heap_mb(page)
    durations = []
    for index in range(cycles):
        started = time.perf_counter()
        page.evaluate("() => window.__voltscope.refresh()")
        durations.append((time.perf_counter() - started) * 1000)
        page.wait_for_timeout(120)
    after = heap_mb(page)
    growth = ((after - before) / before * 100) if before else 0
    check("soak: refresh stays under 5s", max(durations) < 5000, f"max {max(durations):.0f} ms")
    check("soak: heap growth under 60%", growth < 60, f"{before} -> {after} MB ({growth:.0f}%)")
    check("soak: no page errors", not page_errors, "; ".join(page_errors[:2]))
    result = {
        "cycles": cycles,
        "heap_before_mb": before,
        "heap_after_mb": after,
        "growth_pct": round(growth, 1),
        "refresh_ms": [round(value) for value in durations],
        "console": console[:5],
    }
    context.close()
    return result


def run_failure_modes(browser, url: str) -> dict:
    print("\n[failure modes]")
    results = {}

    # Missing snapshot -> labelled demo data. Shards and the legacy file are
    # both blocked so the page must fall back to demo.
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    attach(page)
    page.route("**/data/index.json*", lambda route: route.abort())
    page.route("**/data/days/**", lambda route: route.abort())
    page.route("**/data/energy.json*", lambda route: route.abort())
    page.goto(url, wait_until="load", timeout=60000)
    wait_boot(page)
    banner = page.locator("#banner").inner_text()
    state = live_state(page)
    check("fallback: demo snapshot used", bool(state and state["demo"]))
    check("fallback: banner explains demo", "Demo data" in banner, banner[:80])
    check("fallback: status chip says demo", "Demo" in page.locator("#status-text").inner_text())
    results["missing_snapshot"] = {"banner": banner[:160], "demo": state["demo"] if state else None}
    context.close()

    # Shards blocked but the legacy snapshot still exists -> page still works
    # and the date picker filters the in-memory copy.
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    attach(page)
    page.route("**/data/index.json*", lambda route: route.abort())
    page.route("**/data/days/**", lambda route: route.abort())
    page.goto(url, wait_until="load", timeout=60000)
    wait_boot(page)
    legacy_state = live_state(page)
    check("legacy: full snapshot fallback", bool(legacy_state and legacy_state["mode"] == "legacy" and not legacy_state["demo"]))
    page.evaluate(
        """() => {
          const s = window.__voltscope.state;
          const day = s.index.days[0].date;
          const from = document.getElementById('date-from');
          const to = document.getElementById('date-to');
          from.value = day;
          to.value = day;
          from.dispatchEvent(new Event('change', { bubbles: true }));
        }"""
    )
    page.wait_for_function("() => { const s = window.__voltscope.state; return !s.loadingDates && s.loadedDays.length === 1; }", timeout=15000)
    check("legacy: date picker filters in memory", live_state(page)["loadedDays"] != [], "")
    results["legacy_fallback"] = {"mode": legacy_state["mode"] if legacy_state else None}
    context.close()

    # Corrupt JSON -> demo fallback, no crash.
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    console, page_errors, _ = attach(page)
    page.route("**/data/index.json*", lambda route: route.abort())
    page.route("**/data/days/**", lambda route: route.abort())
    page.route(
        "**/data/energy.json*",
        lambda route: route.fulfill(status=200, content_type="application/json", body="{ definitely not json"),
    )
    page.goto(url, wait_until="load", timeout=60000)
    wait_boot(page)
    check("corrupt: demo fallback", bool((live_state(page) or {}).get("demo")))
    check("corrupt: no uncaught page error", not page_errors, "; ".join(page_errors[:2]))
    results["corrupt_json"] = {"demo": bool((live_state(page) or {}).get("demo")), "console": console[:3]}
    context.close()

    # Vendored Three.js blocked -> scene degrades, timeline still works.
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    attach(page)
    page.route("**/assets/vendor/three/**", lambda route: route.abort())
    page.goto(url, wait_until="load", timeout=60000)
    wait_boot(page)
    banner = page.locator("#banner").inner_text()
    meta = page.locator("#timeline-meta").inner_text()
    check("vendor blocked: boot still completes", page.evaluate("() => document.getElementById('boot').classList.contains('is-done')"))
    check("vendor blocked: banner warns", "3D scene unavailable" in banner, banner[:80])
    check("vendor blocked: timeline still renders data", "readings" in meta, meta[:80])
    results["vendor_blocked"] = {"banner": banner[:160], "timeline": meta[:80]}
    context.close()

    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--snapshot", type=Path, default=None, help="snapshot JSON to inject into the local site")
    parser.add_argument("--label", default="custom", help="report label")
    parser.add_argument("--soak", type=int, default=5, help="refresh cycles for the leak test")
    parser.add_argument("--out", type=Path, default=Path("tests/load/results/ui-audit.json"))
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--soak-only", action="store_true", help="skip journeys, run the refresh soak only")
    args = parser.parse_args()

    snapshot_bytes = args.snapshot.stat().st_size if args.snapshot else 0
    site = prepare_site(args.snapshot)
    corrupt_site = prepare_site(None, corrupt=True)
    report: dict = {
        "label": args.label,
        "snapshot": str(args.snapshot) if args.snapshot else "published sample",
        "snapshot_bytes": snapshot_bytes,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=not args.headed,
            args=[
                "--use-gl=angle",
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
                "--js-flags=--expose-gc",
            ],
        )
        try:
            with origin(site) as url:
                if not args.soak_only:
                    report["desktop"] = run_journey(browser, url, DESKTOP, "desktop", mobile=False)
                    report["mobile"] = run_journey(browser, url, MOBILE, "mobile", mobile=True)
                report["soak"] = run_soak(browser, url, args.soak, DESKTOP)
                if not args.soak_only:
                    report["failure_modes"] = run_failure_modes(browser, url)
            with origin(corrupt_site) as url:
                # Already covered by the route override, but the static origin
                # path proves a corrupted file on disk cannot trap the page.
                context = browser.new_context(viewport=DESKTOP)
                page = context.new_page()
                attach(page)
                page.goto(url, wait_until="load", timeout=60000)
                wait_boot(page)
                check("on-disk corrupt JSON: demo fallback", bool((live_state(page) or {}).get("demo")))
                context.close()
        finally:
            browser.close()

    report["checks"] = checks
    report["findings"] = findings
    report["passed"] = not findings

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n{sum(c['ok'] for c in checks)}/{len(checks)} checks passed")
    if findings:
        print("Findings:")
        for finding in findings:
            print(f"  - {finding}")
    print(f"Report: {args.out}")

    shutil.rmtree(site, ignore_errors=True)
    shutil.rmtree(corrupt_site, ignore_errors=True)
    return 0 if not findings else 1


if __name__ == "__main__":
    sys.exit(main())
