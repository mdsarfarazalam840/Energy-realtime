"""End-to-end browser test for the VoltScope Tech Pulse (Hacker News) page.

Serves the real `docs/` folder from `tests/load/serve_docs.mjs` and drives it
with Chromium through Playwright. The page fetches the Hacker News API at
runtime, so the live path is exercised with Playwright route interception, and
the demo fallback is exercised by aborting the upstream requests.

Usage:
    python tests/load/tech_ui.py
    python tests/load/tech_ui.py --keep

Exit code 1 when an assertion fails.
"""

from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO = Path(__file__).resolve().parents[2]
DOCS = REPO / "docs"
SERVER = Path(__file__).resolve().with_name("serve_docs.mjs")
RESULTS = Path(__file__).resolve().with_name("results")

DESKTOP = {"width": 1440, "height": 900}
MOBILE = {"width": 390, "height": 844}

HN_HOST = "hacker-news.firebaseio.com"

# Synthetic Hacker News payloads used to fake the live API deterministically.
FAKE_IDS = [501, 502, 503, 504, 505, 506, 507, 508, 509, 510]
FAKE_ITEMS = {
    501: {"id": 501, "type": "story", "title": "Diffusion LLMs are very fast", "by": "mdsaif", "score": 1200, "descendants": 300, "time": int(time.time()) - 300, "url": "https://example.com/diffusion"},
    502: {"id": 502, "type": "story", "title": "A faster delta join in SQLite", "by": "sqlite", "score": 800, "descendants": 140, "time": int(time.time()) - 600, "url": "https://example.com/sqlite"},
    503: {"id": 503, "type": "story", "title": "WebGPU ships in all browsers", "by": "gpu", "score": 640, "descendants": 90, "time": int(time.time()) - 2000, "url": "https://example.com/webgpu"},
    504: {"id": 504, "type": "story", "title": "Postgres 18 release notes", "by": "pg", "score": 520, "descendants": 210, "time": int(time.time()) - 3600, "url": "https://example.com/pg"},
    505: {"id": 505, "type": "story", "title": "Why we moved to Go", "by": "golang", "score": 430, "descendants": 80, "time": int(time.time()) - 7200, "url": "https://example.com/go"},
    506: {"id": 506, "type": "story", "title": "Rust async made approachable", "by": "rustacean", "score": 380, "descendants": 120, "time": int(time.time()) - 9000, "url": "https://example.com/rust"},
    507: {"id": 507, "type": "story", "title": "A tiny kernel in Zig", "by": "zig", "score": 300, "descendants": 60, "time": int(time.time()) - 12000, "url": "https://example.com/zig"},
    508: {"id": 508, "type": "story", "title": "Vector search for everyone", "by": "vectors", "score": 240, "descendants": 40, "time": int(time.time()) - 16000, "url": "https://example.com/vectors"},
    509: {"id": 509, "type": "story", "title": "The 2025 frontend framework", "by": "webdev", "score": 180, "descendants": 55, "time": int(time.time()) - 20000, "url": "https://example.com/webdev"},
    510: {"id": 510, "type": "story", "title": "Quantum annealing in CPUs", "by": "qubit", "score": 130, "descendants": 25, "time": int(time.time()) - 30000, "url": "https://example.com/quantum"},
}

checks: list[dict] = []
findings: list[str] = []


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
        deadline = time.time() + 25
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


def prepare_site() -> Path:
    site = Path(tempfile.mkdtemp(prefix="voltscope-tech-"))
    shutil.copytree(DOCS, site, dirs_exist_ok=True)
    return site


def stub_hn(page: Page) -> None:
    """Intercept the Hacker News API with synthetic responses (live path)."""
    def route_hn(route) -> None:
        url = route.request.url
        if "topstories.json" in url:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(FAKE_IDS))
            return
        if "/item/" in url:
            import re
            match = re.search(r"/item/(\d+)\.json", url)
            item_id = int(match.group(1)) if match else None
            item = FAKE_ITEMS.get(item_id)
            if item:
                route.fulfill(status=200, content_type="application/json", body=json.dumps(item))
                return
        route.continue_()

    page.route(f"**://{HN_HOST}/**", route_hn)


def block_hn(page: Page) -> None:
    """Abort upstream Hacker News requests to force the fallback path."""
    page.route(f"**://{HN_HOST}/**", lambda route: route.abort())


def block_cache(page: Page) -> None:
    """Abort the local fail-safe cache file to force the demo fallback."""
    page.route("**/tech-news.json*", lambda route: route.abort())


def wait_loaded(page: Page, timeout: int = 20000) -> None:
    page.wait_for_selector("#story-rows tr", timeout=timeout)
    page.wait_for_function("() => document.querySelector('#boot') === null", timeout=timeout)
    page.wait_for_timeout(400)


def collect_errors(page: Page, *, ignore_network: bool = False) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))

    def on_console(message) -> None:
        if message.type != "error":
            return
        text = message.text
        if ignore_network and ("Failed to load resource" in text or "404" in text or HN_HOST in text):
            return
        errors.append(f"console error: {text}")

    page.on("console", on_console)
    return errors


def scene_canvas(page: Page) -> int:
    return page.locator("#scene canvas.scene-canvas").count()


def story_rows(page: Page) -> list[dict]:
    return page.evaluate(
        """() => [...document.querySelectorAll('#story-rows tr')].map((row) => ({
            id: row.dataset.story,
            selected: row.classList.contains('is-selected'),
            text: row.innerText,
        }))"""
    )


def run_desktop(browser, url: str) -> None:
    print("\n[desktop] live feed (stubbed Hacker News API)")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page)
    stub_hn(page)
    page.goto(f"{url}/tech.html", wait_until="networkidle")
    wait_loaded(page)

    check("page title mentions Tech Pulse", "Tech Pulse" in page.title(), page.title())

    status = page.locator("#status-text").inner_text()
    check("status reports a live feed", "Hacker News" in status, status)

    kpis = [page.locator(selector).inner_text() for selector in ("#kpi-stories", "#kpi-score", "#kpi-domain", "#kpi-comments")]
    check("feed KPIs are populated", all(value not in ("", "—") for value in kpis), " | ".join(kpis))
    check("stories KPI matches the stub", kpis[0] == str(len(FAKE_IDS)), kpis[0])

    rows = story_rows(page)
    check("every story renders in the board", len(rows) == len(FAKE_IDS), f"{len(rows)} rows")
    check("board count summarises the feed", str(len(FAKE_IDS)) in page.locator("#board-count").inner_text())

    check("3D scene creates a WebGL canvas", scene_canvas(page) == 1)
    row = page.locator("#story-rows tr").first
    row.click()
    page.wait_for_timeout(250)
    check("clicking a story selects it", page.locator("#story-rows tr.is-selected").count() == 1)
    focus_body = page.locator("#focus-body").inner_text()
    check("focus panel shows the selected story", "Diffusion LLMs" in focus_body, focus_body[:80])

    page.click("#camera-group button[data-camera='feed']")
    page.wait_for_timeout(200)
    check("camera preset keeps the canvas alive", scene_canvas(page) == 1)

    page.click("#btn-share")
    page.wait_for_timeout(300)
    page.screenshot(path=str(RESULTS / "tech-desktop.png"), full_page=True)
    check("no console or page errors on the live page", not errors, "; ".join(errors[:3]))
    context.close()


def run_table_sort(browser, url: str) -> None:
    print("\n[desktop] table sorting and keyboard")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    stub_hn(page)
    page.goto(f"{url}/tech.html", wait_until="networkidle")
    wait_loaded(page)

    page.click("#story-table th button[data-sort='score']")
    page.wait_for_timeout(200)
    scores = page.evaluate("() => [...document.querySelectorAll('#story-rows .score-tone')].map((el) => el.innerText)")
    check("score sort renders score badges", len(scores) == len(FAKE_IDS), f"{len(scores)} badges")

    page.keyboard.press("KeyT")
    page.wait_for_timeout(150)
    check("theme shortcut toggles theme", page.locator("html").get_attribute("data-theme") == "light", page.locator("html").get_attribute("data-theme"))

    page.keyboard.press("KeyT")
    page.wait_for_timeout(150)
    check("theme toggles back to dark", page.locator("html").get_attribute("data-theme") == "dark", page.locator("html").get_attribute("data-theme"))
    context.close()


def run_mobile(browser, url: str) -> None:
    print("\n[mobile] responsive layout")
    context = browser.new_context(viewport=MOBILE)
    page = context.new_page()
    errors = collect_errors(page)
    stub_hn(page)
    page.goto(f"{url}/tech.html", wait_until="networkidle")
    wait_loaded(page)

    check("mobile board renders every story", len(story_rows(page)) == len(FAKE_IDS))
    overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    check("mobile layout has no horizontal overflow", overflow <= 2, f"{overflow}px")
    page.screenshot(path=str(RESULTS / "tech-mobile.png"), full_page=True)
    check("no console or page errors on mobile", not errors, "; ".join(errors[:3]))
    context.close()


def run_fallback(browser, url: str, *, label: str) -> int:
    print(f"\n[fallback] {label}")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page, ignore_network=True)
    block_hn(page)
    block_cache(page)
    page.goto(f"{url}/tech.html", wait_until="networkidle")
    wait_loaded(page)

    rows = story_rows(page)
    check(f"{label}: demo headline board renders", len(rows) >= 8, f"{len(rows)} rows")
    check(f"{label}: status reports demo", "demo" in page.locator("#status-text").inner_text().lower(), page.locator("#status-text").inner_text())
    check(f"{label}: demo KPIs populated", page.locator("#kpi-stories").inner_text() not in ("", "—"))
    check(f"{label}: 3D scene still boots on demo data", scene_canvas(page) == 1)
    check(f"{label}: no console or page errors", not errors, "; ".join(errors[:3]))
    page.screenshot(path=str(RESULTS / f"tech-{label}.png"), full_page=True)
    context.close()
    return len(rows)


def run_cache_fallback(browser, url: str) -> int:
    """Live API down but the committed fail-safe cache is available."""
    print("\n[fallback] cache (fail-safe cache)")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page, ignore_network=True)
    block_hn(page)  # live API down; cache file is left intact
    page.goto(f"{url}/tech.html", wait_until="networkidle")
    wait_loaded(page)

    rows = story_rows(page)
    status_text = page.locator("#status-text").inner_text().lower()
    check("cache: headline board renders from cache", len(rows) >= 8, f"{len(rows)} rows")
    check("cache: status reports cached", "cached" in status_text, status_text)
    check("cache: status is not demo", "demo" not in status_text, status_text)
    check("cache: KPIs populated", page.locator("#kpi-stories").inner_text() not in ("", "—"))
    check("cache: 3D scene boots on cached data", scene_canvas(page) == 1)
    check("cache: no console or page errors", not errors, "; ".join(errors[:3]))
    page.screenshot(path=str(RESULTS / "tech-cache.png"), full_page=True)
    context.close()
    return len(rows)


def run_navigation(browser, url: str) -> None:
    print("\n[navigation] links between dashboards")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    for path, label in (("index.html", "energy"), ("crypto.html", "crypto"), ("finance.html", "finance")):
        page.goto(f"{url}/{path}", wait_until="domcontentloaded")
        check(f"{label} page links to tech", page.locator("a[href='tech.html']").count() >= 1, path)
    page.goto(f"{url}/tech.html", wait_until="domcontentloaded")
    check("tech page links back to energy", page.locator("a[href='index.html']").count() >= 1)
    context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep temporary sites for inspection")
    parser.add_argument("--headed", action="store_true", help="run Chromium with a visible window")
    args = parser.parse_args()

    RESULTS.mkdir(parents=True, exist_ok=True)
    site = prepare_site()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=not args.headed)
            try:
                with origin(site) as url:
                    run_desktop(browser, url)
                    run_table_sort(browser, url)
                    run_mobile(browser, url)
                    demo_count = run_fallback(browser, url, label="demo")
                    check("demo fallback renders a full board", demo_count >= 8, f"{demo_count} rows")
                    cache_count = run_cache_fallback(browser, url)
                    check("cache fallback renders a full board", cache_count >= 8, f"{cache_count} rows")
                with origin(DOCS) as url:
                    run_navigation(browser, url)
            finally:
                browser.close()
    finally:
        if not args.keep:
            shutil.rmtree(site, ignore_errors=True)

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "checks": checks,
        "passed": sum(1 for item in checks if item["ok"]),
        "failed": len(findings),
    }
    (RESULTS / "tech-ui.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"\n{payload['passed']} passed, {payload['failed']} failed")
    if findings:
        print("\nFindings:")
        for finding in findings:
            print(f"  - {finding}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
