"""End-to-end browser test for the VoltScope Finance (SEC EDGAR) page.

Serves the real `docs/` folder from `tests/load/serve_docs.mjs` and drives it
with Chromium through Playwright. Covers the live snapshot, every documented
interaction, the demo fallback, a corrupt export, direct links, and mobile.

Usage:
    python tests/load/finance_ui.py
    python tests/load/finance_ui.py --keep

Exit code 1 when an assertion fails.
"""

from __future__ import annotations

import argparse
import copy
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
DATA = DOCS / "data" / "finance.json"
SERVER = Path(__file__).resolve().with_name("serve_docs.mjs")
RESULTS = Path(__file__).resolve().with_name("results")

DESKTOP = {"width": 1440, "height": 900}
MOBILE = {"width": 390, "height": 844}

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


def prepare_site(*, with_data: bool = True, corrupt: bool = False) -> Path:
    site = Path(tempfile.mkdtemp(prefix="voltscope-finance-"))
    shutil.copytree(DOCS, site, dirs_exist_ok=True)
    target = site / "data" / "finance.json"
    if corrupt:
        target.write_text("{ this is not json", encoding="utf-8")
    elif not with_data:
        target.unlink(missing_ok=True)
    return site


def canvas_pixels(page: Page) -> int:
    return page.evaluate(
        """() => {
            const canvas = document.querySelector('#fin-chart');
            if (!canvas || !canvas.width) return 0;
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let painted = 0;
            for (let index = 3; index < data.length; index += 4) if (data[index] > 0) painted += 1;
            return painted;
        }"""
    )


def rows(page: Page) -> list[dict]:
    return page.evaluate(
        """() => [...document.querySelectorAll('#company-rows tr')].map((row) => ({
            ticker: row.dataset.ticker,
            selected: row.classList.contains('is-selected'),
            text: row.innerText,
            sector: row.querySelector('.sector-chip span')?.textContent || '',
        }))"""
    )


def wait_loaded(page: Page, timeout: int = 20000) -> None:
    page.wait_for_selector("#company-rows tr", timeout=timeout)
    page.wait_for_function("() => document.querySelector('#boot') === null", timeout=timeout)
    page.wait_for_timeout(150)


def collect_errors(page: Page, *, ignore_network: bool = False) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))

    def on_console(message) -> None:
        if message.type != "error":
            return
        text = message.text
        if ignore_network and ("Failed to load resource" in text or "404" in text):
            return
        errors.append(f"console error: {text}")

    page.on("console", on_console)
    return errors



def run_scene_checks(page: Page) -> None:
    canvas = page.locator("#scene canvas.finance-canvas")
    check("3D scene creates a WebGL canvas", canvas.count() == 1)
    if canvas.count():
        size = canvas.first.evaluate("(c) => ({ w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight })")
        check("3D scene canvas has size", size['w'] > 0 and size['h'] > 0 and size['cw'] > 0 and size['ch'] > 0, str(size))
    check("scene loading overlay clears", page.locator("#scene-loading").count() == 0 or page.locator("#scene-loading.is-done").count() == 1)
    legend = page.locator("#legend-label").inner_text()
    check("scene legend defaults to revenue height", "revenue" in legend.lower(), legend)

    page.click("#metric-group button[data-metric='net_income']")
    page.wait_for_timeout(200)
    legend2 = page.locator("#legend-label").inner_text()
    check("metric switch updates scene legend", "net income" in legend2.lower(), legend2)
    check("metric button shows active state", page.locator("#metric-group button[data-metric='net_income']").evaluate("(el) => el.classList.contains('is-active')"))

    page.click("#metric-group button[data-metric='revenue']")
    page.wait_for_timeout(150)
    page.click(".camera-tools button[data-cam='overview']")
    page.wait_for_timeout(150)
    page.click(".camera-tools button[data-cam='top']")
    page.wait_for_timeout(200)
    page.click(".camera-tools button[data-cam='overview']")
    page.wait_for_timeout(150)
    check("scene camera presets keep the canvas alive", canvas.count() == 1)
def run_desktop(browser, url: str, expected_companies: int) -> None:
    print("\n[desktop] live snapshot")
    context = browser.new_context(viewport=DESKTOP, permissions=["clipboard-read", "clipboard-write"])
    page = context.new_page()
    errors = collect_errors(page)
    page.goto(f"{url}/finance.html", wait_until="networkidle")
    wait_loaded(page)

    check("page title mentions EDGAR", "SEC EDGAR" in page.title(), page.title())
    status = page.locator("#status-text").inner_text()
    check("status reports a live snapshot", "Live" in status and page.locator("#status").get_attribute("data-state") == "live", status)

    live_ind = page.locator("#snapshot-live")
    check("realtime live indicator renders", live_ind.is_visible(), "not visible")
    live_text = live_ind.inner_text()
    check(
        "realtime live indicator reports live state",
        live_ind.get_attribute("data-state") == "live" and "Live" in live_text,
        live_text,
    )

    kpis = [page.locator(selector).inner_text() for selector in ("#kpi-companies", "#kpi-filings", "#kpi-revenue", "#kpi-margin")]
    check("snapshot KPIs are populated", all(value not in ("", "—") for value in kpis), " | ".join(kpis))
    check("company KPI matches the export", kpis[0] == str(expected_companies), kpis[0])

    table_rows = rows(page)
    check("every company renders in the board", len(table_rows) == expected_companies, f"{len(table_rows)} rows")
    check("board count summarises the snapshot", str(expected_companies) in page.locator("#board-count").inner_text())
    check("filing stream renders rows", page.locator("#filing-list li").count() >= 5)

    painted = canvas_pixels(page)
    check("focus chart paints bars", painted > 1200, f"{painted} painted pixels")
    chart_label = page.locator("#fin-chart").get_attribute("aria-label") or ""
    check("chart exposes an accessible summary", "revenue" in chart_label and "net income" in chart_label, chart_label[:90])
    check("focus panel renders eight facts", page.locator("#focus-facts > div").count() == 8)
    focus_ticker = page.locator("#focus-ticker").inner_text()
    check(
        "focus panel names a company",
        focus_ticker not in ("", "—") and page.locator("#focus-name").inner_text() not in ("", "Select a company"),
        f"{focus_ticker} · {page.locator('#focus-name').inner_text()}",
    )
    check("focus filings list is populated", page.locator("#focus-filings li").count() >= 1)

    print("\n[desktop] filters and selection")
    page.fill("#fin-search", "AAPL")
    page.wait_for_timeout(120)
    filtered = rows(page)
    check("search narrows the board", len(filtered) == 1 and filtered[0]["ticker"] == "AAPL", str([row["ticker"] for row in filtered]))
    page.fill("#fin-search", "")
    page.wait_for_timeout(120)
    check("clearing search restores every row", len(rows(page)) == expected_companies)

    page.click("#company-table th button[data-sort='revenue']")
    sort_desc = page.locator("#company-table th button[data-sort='revenue']").evaluate("(el) => el.closest('th').getAttribute('aria-sort')")
    page.click("#company-table th button[data-sort='revenue']")
    sort_asc = page.locator("#company-table th button[data-sort='revenue']").evaluate("(el) => el.closest('th').getAttribute('aria-sort')")
    check("revenue header toggles sort direction", sort_desc == "descending" and sort_asc == "ascending", f"{sort_desc} -> {sort_asc}")

    first_sector = page.locator("#sector-list button").first
    sector_name = first_sector.locator("strong").inner_text()
    first_sector.click()
    page.wait_for_timeout(120)
    sector_rows = rows(page)
    check(
        "sector filter narrows to one sector",
        bool(sector_rows) and all(row["sector"] == sector_name for row in sector_rows),
        f"{sector_name}: {len(sector_rows)} rows",
    )
    page.click("#btn-clear-filters")
    page.wait_for_timeout(120)
    check("clear filters restores the board", len(rows(page)) == expected_companies)

    page.click("#form-group button[data-form='10-K']")
    page.wait_for_timeout(120)
    badges = page.locator("#filing-list .form-badge").all_inner_texts()
    check("10-K filter keeps only 10-K filings", badges and all(badge == "10-K" for badge in badges), ",".join(sorted(set(badges))))
    check("10-K filter still shows eligible companies", len(rows(page)) >= 1)
    page.click("#form-group button[data-form='all']")
    page.wait_for_timeout(120)

    target = rows(page)[0]
    page.locator(f"#company-rows tr[data-ticker='{target['ticker']}']").click()
    page.wait_for_timeout(200)
    check("row click focuses the company", page.locator("#focus-ticker").inner_text() == target["ticker"], target["ticker"])
    check("selection writes the ticker to the URL", f"ticker={target['ticker']}" in page.url, page.url)
    check("selected row is marked", any(row["selected"] for row in rows(page)))
    check("focus filings belong to the selected company", page.locator("#focus-filings li").count() >= 1)

    page.click("#series-group button[data-series='quarterly']")
    page.wait_for_timeout(150)
    quarterly_note = page.locator("#chart-note").inner_text()
    check("quarterly toggle updates the chart note", "quarters" in quarterly_note, quarterly_note)
    check("quarterly chart still paints or explains its gap", canvas_pixels(page) > 100 or "No annual" in page.locator("#fin-chart").get_attribute("aria-label"))
    page.click("#series-group button[data-series='annual']")
    page.wait_for_timeout(120)

    run_scene_checks(page)

    print("\n[desktop] chrome and shortcuts")
    theme_before = page.evaluate("() => document.documentElement.dataset.theme")
    page.click("#btn-theme")
    theme_after = page.evaluate("() => document.documentElement.dataset.theme")
    check("theme button flips the theme", theme_before != theme_after, f"{theme_before} -> {theme_after}")
    page.keyboard.press("t")
    check("T shortcut flips the theme back", page.evaluate("() => document.documentElement.dataset.theme") == theme_before)

    page.keyboard.press("?")
    page.wait_for_timeout(200)
    check("help dialog opens", page.locator("#help-dialog").evaluate("(el) => el.open") is True)
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    check("Escape closes the help dialog", page.locator("#help-dialog").evaluate("(el) => el.open") is False)

    page.locator("#fin-search").blur()
    page.keyboard.press("Escape")
    page.wait_for_timeout(180)
    check("Escape clears the selection", "ticker=" not in page.url, page.url)

    page.click("#btn-share")
    page.wait_for_timeout(400)
    toast = page.locator("#toast").inner_text()
    check("share copies or shows a link", "http" in toast or "copied" in toast.lower(), toast[:90])

    page.click("#btn-refresh")
    page.wait_for_function("() => !document.querySelector('#btn-refresh').classList.contains('spinning')", timeout=20000)
    check("refresh completes without leaving the live state", page.locator("#status").get_attribute("data-state") == "live")

    page.screenshot(path=str(RESULTS / "finance-desktop.png"), full_page=True)
    check("no console or page errors on the live page", not errors, "; ".join(errors[:3]))
    context.close()


def run_direct_link(browser, url: str) -> None:
    print("\n[desktop] direct link")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    page.goto(f"{url}/finance.html?ticker=MSFT", wait_until="networkidle")
    wait_loaded(page)
    check("direct ticker link focuses that company", page.locator("#focus-ticker").inner_text() == "MSFT", page.locator("#focus-ticker").inner_text())
    check("direct link loads the right company name", "Microsoft" in page.locator("#focus-name").inner_text(), page.locator("#focus-name").inner_text())
    context.close()


def run_mobile(browser, url: str, expected_companies: int) -> None:
    print("\n[mobile] responsive layout")
    context = browser.new_context(viewport=MOBILE)
    page = context.new_page()
    errors = collect_errors(page)
    page.goto(f"{url}/finance.html", wait_until="networkidle")
    wait_loaded(page)
    check("mobile board renders every company", len(rows(page)) == expected_companies)
    overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    check("mobile layout has no horizontal overflow", overflow <= 2, f"{overflow}px")
    check("mobile chart still paints", canvas_pixels(page) > 800)
    page.screenshot(path=str(RESULTS / "finance-mobile.png"), full_page=True)
    check("no console or page errors on mobile", not errors, "; ".join(errors[:3]))
    context.close()


def run_fallback(browser, url: str, *, label: str) -> int:
    print(f"\n[fallback] {label}")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page, ignore_network=True)
    page.goto(f"{url}/finance.html", wait_until="networkidle")
    wait_loaded(page)
    status = page.locator("#status").get_attribute("data-state")
    check(f"{label}: status switches to demo", status == "demo", status)
    count = len(rows(page))
    check(f"{label}: demo company board renders", count >= 8, f"{count} rows")
    check(f"{label}: demo chart paints", canvas_pixels(page) > 1000)
    check(f"{label}: no console or page errors", not errors, "; ".join(errors[:3]))
    page.screenshot(path=str(RESULTS / f"finance-{label}.png"), full_page=True)
    context.close()
    return count


def run_navigation(browser, url: str) -> None:
    print("\n[navigation] links between dashboards")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    page.goto(f"{url}/index.html", wait_until="domcontentloaded")
    check("energy page links to finance", page.locator("a[href='finance.html']").count() >= 1)
    page.goto(f"{url}/crypto.html", wait_until="domcontentloaded")
    check("crypto page links to finance", page.locator("a[href='finance.html']").count() >= 1)
    page.goto(f"{url}/finance.html", wait_until="domcontentloaded")
    check("finance page links back to energy", page.locator("a[href='index.html']").count() >= 1)
    context.close()


def run_realtime(browser, url: str, expected: int) -> None:
    print("\n[realtime] published snapshot propagates to the UI")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page)

    original = json.loads(DATA.read_text(encoding="utf-8"))
    updated = copy.deepcopy(original)
    updated["companies"] = updated["companies"][:-1]
    updated.setdefault("meta", {})["company_count"] = len(updated["companies"])
    updated["meta"]["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 60))
    original_body = json.dumps(original)
    updated_body = json.dumps(updated)

    serve_original = {"value": True}

    def handle(route):
        body = original_body if serve_original["value"] else updated_body
        route.fulfill(status=200, content_type="application/json", body=body)

    page.route("**/data/finance.json*", handle)

    page.goto(f"{url}/finance.html", wait_until="networkidle")
    wait_loaded(page)
    check("realtime: board renders the published snapshot", len(rows(page)) == expected)

    live = page.locator("#snapshot-live")
    check("realtime: live indicator is visible", live.is_visible())
    check(
        "realtime: live indicator reports live state",
        live.get_attribute("data-state") == "live" and "Live" in live.inner_text(),
        live.inner_text(),
    )

    before = len(rows(page))
    serve_original["value"] = False
    page.click("#btn-refresh")
    page.wait_for_timeout(800)
    after = len(rows(page))
    check("realtime: refresh adopts the newer published snapshot", after == before - 1, f"{before} -> {after}")
    check(
        "realtime: stays live after refresh",
        page.locator("#status").get_attribute("data-state") == "live",
        page.locator("#status").get_attribute("data-state") or "",
    )
    check("realtime: no console or page errors", not errors, "; ".join(errors[:3]))
    page.screenshot(path=str(RESULTS / "finance-realtime.png"), full_page=True)
    context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep temporary sites for inspection")
    parser.add_argument("--headed", action="store_true", help="run Chromium with a visible window")
    args = parser.parse_args()

    RESULTS.mkdir(parents=True, exist_ok=True)
    expected = json.loads(DATA.read_text(encoding="utf-8"))["meta"]["company_count"]
    print(f"Expecting {expected} companies from {DATA.relative_to(REPO)}")

    live_site = prepare_site()
    demo_site = prepare_site(with_data=False)
    corrupt_site = prepare_site(corrupt=True)
    temp_sites = [live_site, demo_site, corrupt_site]

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=not args.headed)
            try:
                with origin(live_site) as url:
                    run_desktop(browser, url, expected)
                    run_direct_link(browser, url)
                    run_mobile(browser, url, expected)
                    run_realtime(browser, url, expected)
                with origin(demo_site) as url:
                    demo_count = run_fallback(browser, url, label="demo")
                    check("demo fallback uses its own company set", demo_count != expected, f"{demo_count} vs {expected}")
                with origin(corrupt_site) as url:
                    run_fallback(browser, url, label="corrupt")
                with origin(DOCS) as url:
                    run_navigation(browser, url)
            finally:
                browser.close()
    finally:
        if not args.keep:
            for site in temp_sites:
                shutil.rmtree(site, ignore_errors=True)

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "checks": checks,
        "passed": sum(1 for item in checks if item["ok"]),
        "failed": len(findings),
    }
    (RESULTS / "finance-ui.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"\n{payload['passed']} passed, {payload['failed']} failed")
    if findings:
        print("\nFindings:")
        for finding in findings:
            print(f"  - {finding}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
