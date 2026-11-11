"""End-to-end browser test for the VoltScope Global News & Culture page.

Serves the real `docs/` folder from `tests/load/serve_docs.mjs` and drives it with
Chromium through Playwright. The Wikimedia Pageviews API is stubbed for the live
path and aborted for the demo fallback, so the test is deterministic and never
touches the public hosts.

Usage:
    python tests/load/news_ui.py
    python tests/load/news_ui.py --keep --headed

Exit code 1 when an assertion fails.
"""

from __future__ import annotations

import argparse
import json
import re
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
RESULTS = Path(__file__).resolve().with_name("results")

DESKTOP = {"width": 1440, "height": 900}
MOBILE = {"width": 390, "height": 844}
WIKI_HOST = "wikimedia.org"

# Synthetic Wikipedia payloads. Three maintenance pages come first on purpose:
# the page must drop them before it ranks the real stories.
FAKE_ARTICLES = [
    {"article": "Main_Page", "views": 9000000, "rank": 1},
    {"article": "Special:Search", "views": 2000000, "rank": 2},
    {"article": "Wikipedia:Featured_pictures", "views": 1500000, "rank": 3},
    {"article": "Taylor_Swift", "views": 1000000, "rank": 4},
    {"article": "Artificial_intelligence", "views": 900000, "rank": 5},
    {"article": "World_War_II", "views": 800000, "rank": 6},
    {"article": "2026_FIFA_World_Cup", "views": 700000, "rank": 7},
    {"article": "Bitcoin", "views": 600000, "rank": 8},
    {"article": "Japan", "views": 500000, "rank": 9},
    {"article": "The_Lord_of_the_Rings", "views": 400000, "rank": 10},
    {"article": "Wimbledon_Championships", "views": 300000, "rank": 11},
    {"article": "Climate_change", "views": 200000, "rank": 12},
    {"article": "Dune_(2021_film)", "views": 150000, "rank": 13},
    {"article": "Oppenheimer_(film)", "views": 100000, "rank": 14},
]
EXPECTED_STORIES = 11  # 14 payload rows minus the three maintenance pages

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
    site = Path(tempfile.mkdtemp(prefix="voltscope-news-"))
    shutil.copytree(DOCS, site, dirs_exist_ok=True)
    return site


def stub_wikipedia(page: Page) -> None:
    """Intercept the Wikimedia Pageviews API with a synthetic payload."""

    def route_wiki(route) -> None:
        if "/metrics/pageviews/top/" in route.request.url:
            body = {"items": [{"articles": FAKE_ARTICLES}]}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
            return
        route.continue_()

    page.route(f"**://{WIKI_HOST}/**", route_wiki)


def block_wikipedia(page: Page) -> None:
    page.route(f"**://{WIKI_HOST}/**", lambda route: route.abort())
    page.route("**/news-cache.json*", lambda route: route.abort())


def collect_errors(page: Page, *, ignore_network: bool = False) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))

    def on_console(message) -> None:
        if message.type != "error":
            return
        text = message.text
        if ignore_network and (
            "Failed to load resource" in text or "404" in text or WIKI_HOST in text or "net::ERR" in text
        ):
            return
        errors.append(f"console error: {text}")

    page.on("console", on_console)
    return errors


def wait_loaded(page: Page, timeout: int = 20000) -> None:
    page.wait_for_selector("#article-rows tr[data-article]", timeout=timeout)
    page.wait_for_function("() => document.querySelector('#boot') === null", timeout=timeout)
    page.wait_for_timeout(400)


def rows(page: Page) -> list[dict]:
    return page.evaluate(
        """() => [...document.querySelectorAll('#article-rows tr[data-article]')].map((row) => ({
            id: row.dataset.article,
            selected: row.classList.contains('is-selected'),
            text: row.innerText,
        }))"""
    )


def scene_canvas(page: Page) -> int:
    return page.locator("#scene canvas.scene-canvas").count()


def run_desktop(browser, url: str) -> None:
    print("\n[desktop] live feed (stubbed Wikimedia API)")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page)
    stub_wikipedia(page)
    page.goto(f"{url}/news.html", wait_until="networkidle")
    wait_loaded(page)

    check("page title names the dashboard", "News & Culture" in page.title(), page.title())
    check("hero headline is present", page.locator("h1#page-title").inner_text() == "What the world is reading")
    check("status reports the live feed", "Wikipedia" in page.locator("#status-text").inner_text(), page.locator("#status-text").inner_text())

    kpis = [page.locator(selector).inner_text() for selector in ("#kpi-articles", "#kpi-views", "#kpi-category", "#kpi-avg")]
    check("KPIs are populated", all(value not in ("", "—") for value in kpis), " | ".join(kpis))
    check("story count matches the stubbed feed", kpis[0] == str(EXPECTED_STORIES), kpis[0])

    board = rows(page)
    check("maintenance pages are filtered out", len(board) == EXPECTED_STORIES, f"{len(board)} rows")
    meta_leak = [row["text"] for row in board if re.search(r"Main Page|Special:Search|Wikipedia:Featured", row["text"])]
    check("no Wikipedia namespace pages reach the board", not meta_leak, "; ".join(meta_leak[:2]))

    lead = board[0]["text"]
    check("the lead story is the most-viewed real article", "Taylor Swift" in lead, lead[:80])
    check("board count summarises the feed", str(EXPECTED_STORIES) in page.locator("#board-count").inner_text())
    check("spotlight shows the lead story", page.locator("#spotlight-title").inner_text() == "Taylor Swift")

    check("3D scene creates a WebGL canvas", scene_canvas(page) == 1)
    check("category legend renders", page.locator("#stage-legend .legend-item").count() >= 3)
    check("category mix renders", page.locator("#mix-list .mix-row").count() >= 4)

    # Category inference: a few high-signal stories must land in the right bucket.
    text_by_id = {row["id"]: row["text"] for row in board}
    check("Music category inferred", "Music" in text_by_id.get("Taylor_Swift", ""), text_by_id.get("Taylor_Swift", "")[:60])
    check("Sports category inferred", "Sports" in text_by_id.get("2026_FIFA_World_Cup", ""), text_by_id.get("2026_FIFA_World_Cup", "")[:60])
    check("Finance category inferred", "Finance" in text_by_id.get("Bitcoin", ""), text_by_id.get("Bitcoin", "")[:60])
    check("History category inferred", "History" in text_by_id.get("World_War_II", ""), text_by_id.get("World_War_II", "")[:60])

    page.locator("#article-rows tr", has_text="Bitcoin").click()
    page.wait_for_timeout(250)
    check("clicking a story selects exactly one row", page.locator("#article-rows tr.is-selected").count() == 1)
    focus_body = page.locator("#focus-body").inner_text()
    check("focus panel shows the selected story", "Bitcoin" in focus_body, focus_body[:80])
    check("focus panel reports the original rank", "#5" in focus_body, focus_body[:120])
    href = page.locator("#focus-body a.btn-primary").get_attribute("href") or ""
    check("focus links to Wikipedia", href.startswith("https://en.wikipedia.org/wiki/"), href)

    page.fill("#article-search", "bitcoin")
    page.wait_for_timeout(250)
    filtered = rows(page)
    check("search filters the ranking", len(filtered) == 1 and "Bitcoin" in filtered[0]["text"], f"{len(filtered)} rows")
    check("board count explains the filter", "1 of 11" in page.locator("#board-count").inner_text(), page.locator("#board-count").inner_text())
    page.keyboard.press("Escape")
    page.wait_for_timeout(250)
    check("Escape clears the filter", len(rows(page)) == EXPECTED_STORIES, f"{len(rows(page))} rows")

    page.click("#article-table th button[data-sort='title']")
    page.wait_for_timeout(200)
    check("title sort puts the alphabetically first story on top", rows(page)[0]["id"] == "2026_FIFA_World_Cup", rows(page)[0]["text"][:60])
    page.click("#article-table th button[data-sort='views']")
    page.wait_for_timeout(200)
    check("views sort restores the lead story", "Taylor Swift" in rows(page)[0]["text"], rows(page)[0]["text"][:60])

    page.keyboard.press("KeyT")
    page.wait_for_timeout(200)
    check("theme shortcut switches to light", page.locator("html").get_attribute("data-theme") == "light")
    page.keyboard.press("KeyT")
    page.wait_for_timeout(200)
    check("theme shortcut switches back to dark", page.locator("html").get_attribute("data-theme") == "dark")

    page.click("#btn-auto")
    page.wait_for_timeout(150)
    check("auto-refresh can be paused", page.locator("#btn-auto").get_attribute("aria-pressed") == "false")
    check("next-refresh label reports the pause", any("Paused" in text for text in page.locator("[data-next]").all_inner_texts()))
    page.click("#btn-auto")
    page.wait_for_timeout(150)
    check("auto-refresh can be resumed", page.locator("#btn-auto").get_attribute("aria-pressed") == "true")

    page.click("#btn-help")
    page.wait_for_timeout(200)
    check("help dialog opens", page.locator("#help-dialog").is_visible())
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    check("help dialog closes", not page.locator("#help-dialog").is_visible())

    page.click("#stage-spotlight")
    page.wait_for_timeout(250)
    check("spotlight focuses the lead story", "Taylor Swift" in page.locator("#focus-body").inner_text())

    theme_select = page.locator("#theme-select")
    theme_select.select_option("city")
    page.wait_for_timeout(300)
    check("constellation theme switch keeps the canvas alive", scene_canvas(page) == 1)
    theme_select.select_option("globe")
    page.wait_for_timeout(200)

    page.locator("#article-table th button[data-sort='views']").first.scroll_into_view_if_needed()
    page.screenshot(path=str(RESULTS / "news-desktop.png"), full_page=True)
    check("no console or page errors on the live page", not errors, "; ".join(errors[:3]))
    context.close()


def run_mobile(browser, url: str) -> None:
    print("\n[mobile] responsive layout")
    context = browser.new_context(viewport=MOBILE)
    page = context.new_page()
    errors = collect_errors(page)
    stub_wikipedia(page)
    page.goto(f"{url}/news.html", wait_until="networkidle")
    wait_loaded(page)

    check("mobile ranking renders every story", len(rows(page)) == EXPECTED_STORIES, f"{len(rows(page))} rows")
    overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    check("mobile layout has no horizontal overflow", overflow <= 2, f"{overflow}px")
    check("mobile keeps the 3D stage", scene_canvas(page) == 1)
    check("mobile hides the share column", page.locator("#article-rows .share-cell:visible").count() == 0)
    check("mobile search field is usable", page.locator("#article-search").is_visible())

    page.locator("#article-rows tr").first.click()
    page.wait_for_timeout(500)
    check("mobile selection updates Focus", "Taylor Swift" in page.locator("#focus-body").inner_text())

    page.screenshot(path=str(RESULTS / "news-mobile.png"), full_page=True)
    check("no console or page errors on mobile", not errors, "; ".join(errors[:3]))
    context.close()


def run_fallback(browser, url: str) -> int:
    print("\n[fallback] live API and cache blocked")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page, ignore_network=True)
    block_wikipedia(page)
    page.goto(f"{url}/news.html", wait_until="networkidle")
    wait_loaded(page)

    board = rows(page)
    check("demo fallback renders a full board", len(board) >= 8, f"{len(board)} rows")
    check("demo fallback is labelled in the status", "demo" in page.locator("#status-text").inner_text().lower(), page.locator("#status-text").inner_text())
    check("demo fallback is labelled in feed health", "demo" in page.locator("#feed-state-label").inner_text().lower(), page.locator("#feed-state-label").inner_text())
    check("demo fallback keeps the 3D scene", scene_canvas(page) == 1)
    check("demo fallback starts at rank one", board[0]["text"].startswith("01"), board[0]["text"][:40])
    page.screenshot(path=str(RESULTS / "news-demo.png"), full_page=True)
    check("no page errors on the demo fallback", not errors, "; ".join(errors[:3]))
    context.close()
    return len(board)


def run_navigation(browser, url: str) -> None:
    print("\n[navigation] links between dashboards")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    for path in ("index.html", "crypto.html", "finance.html", "tech.html", "ai.html", "space.html", "flights.html"):
        page.goto(f"{url}/{path}", wait_until="domcontentloaded")
        check(f"{path} links to the news page", page.locator("a[href='news.html']").count() >= 1, path)
    page.goto(f"{url}/news.html", wait_until="domcontentloaded")
    check("news page links back to energy", page.locator("a[href='index.html']").count() >= 1)
    context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep the temporary site for inspection")
    parser.add_argument("--headed", action="store_true", help="run Chromium with a visible window")
    args = parser.parse_args()

    try:  # Windows consoles default to a legacy code page; keep emoji/arrows safe.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older streams may not support reconfigure
        pass

    RESULTS.mkdir(parents=True, exist_ok=True)
    site = prepare_site()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=not args.headed)
            try:
                with origin(site) as url:
                    run_desktop(browser, url)
                    run_mobile(browser, url)
                    run_fallback(browser, url)
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
    (RESULTS / "news-ui.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"\n{payload['passed']} passed, {payload['failed']} failed")
    if findings:
        print("\nFindings:")
        for finding in findings:
            print(f"  - {finding}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
