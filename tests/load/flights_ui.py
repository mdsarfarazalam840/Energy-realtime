"""End-to-end browser test for the VoltScope Flights page.

Serves the real `docs/` folder from `tests/load/serve_docs.mjs` and drives it
with Chromium through Playwright, mirroring the finance page test. Covers the
live snapshot state, the selection/theme/filter chrome, the deterministic demo
fallback (via a mirror with a corrupt snapshot), and page-level errors.

Usage:
    python tests/load/flights_ui.py
    python tests/load/flights_ui.py --keep

Exit code 1 when an assertion fails. Runs the common check against a local
in-memory mirror of `docs/` — never against the live Pages host.
"""

from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO = Path(__file__).resolve().parents[2]
DOCS = REPO / "docs"
DATA = DOCS / "data" / "flights.json"
SERVER = Path(__file__).resolve().with_name("serve_docs.mjs")
RESULTS = Path(__file__).resolve().with_name("results")
VIEWPORT = {"width": 1440, "height": 900}


def now_stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


checks: list[dict] = []
findings: list[str] = []
page_errors: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    checks.append({"name": name, "ok": bool(ok), "detail": detail})
    if not ok:
        findings.append(f"{name}: {detail}" if detail else name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' - ' + detail) if detail else ''}")
    return ok


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


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
            except Exception:
                time.sleep(0.2)
        else:
            raise RuntimeError("local docs mirror did not come up")
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def snapshot_state(page: Page) -> dict:
    return page.evaluate("() => (window.__flights && window.__flights.stats()) || null")


def wait_until(fn, timeout: float = 20.0, interval: float = 0.25, detail: str = "condition"):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    check(f"wait {detail}", False, f"timed out after {timeout:.0f}s (last: {last})")
    return last


def run_live_checks(page: Page, url: str) -> None:
    page.goto(url + "/flights.html", wait_until="domcontentloaded")
    try:
        page.wait_for_selector("#flights-scene canvas", timeout=15000)
        check("globe canvas mounted", True)
    except Exception as error:  # noqa: BLE001 - report anything the page threw
        check("globe canvas mounted", False, str(error))

    title = page.title()
    check("page title is VoltScope Flights", "VoltScope Flights" in title, title)

    wait_until(lambda: page.evaluate("() => !!(window.__flights)"), detail="window.__flights")
    check("window.__flights present", True)

    wait_until(
        lambda: (page.locator("#status").get_attribute("data-state") or "") not in ("", "loading"),
        detail="status chip leaves 'loading'",
    )
    state = page.locator("#status").get_attribute("data-state")
    check("status chip settled", state in ("live", "demo", "stale"), f"data-state={state}")

    def ready_stats() -> dict | None:
        state = snapshot_state(page)
        return state if (state and state.get("total", 0) >= 1) else None

    stats = wait_until(ready_stats, detail="stats with non-zero aircraft")
    if stats:
        plotted = stats["plotted"]
        summary = page.locator("#flights-summary").inner_text()
        check(
            "summary matches plotted count",
            f"{plotted} aircraft" in summary,
            f"summary='{summary}' plotted={plotted}",
        )
        source = page.locator("#flights-source").inner_text()
        check("source line renders", source != "—", f"source='{source}'")
        check("ops hook sane", isinstance(stats.get("asOf"), (str, type(None))), f"asOf={stats.get('asOf')}")

    options = page.locator("#flights-country option").count()
    check("country filter populated", options >= 2, f"{options} options")  # select + at least one country

    icaos = page.evaluate("() => window.__flights.listIcaos()")
    check("listIcaos exposed by page hook", isinstance(icaos, list) and len(icaos) >= 1, f"{type(icaos).__name__} len={len(icaos) if isinstance(icaos, list) else 'n/a'}")
    if icaos:
        first = icaos[0]
        page.evaluate("(icao) => window.__flights.select(icao)", first)
        text = page.locator("#flight-selected").inner_text()
        check("selection shows aircraft detail", first in text, f"text='{text[:80]}'")

    theme_before = page.evaluate("() => document.documentElement.dataset.theme")
    page.click("#btn-theme")
    theme_after = page.evaluate("() => document.documentElement.dataset.theme")
    check("theme toggle flips data-theme", theme_after != theme_before, f"{theme_before} -> {theme_after}")

    page.click("#btn-help")
    open_state = page.evaluate("() => (document.getElementById('help-dialog') || {}).open === true")
    check("help dialog opens", open_state is True)
    page.click("#btn-help-close")
    closed_state = page.evaluate("() => (document.getElementById('help-dialog') || {}).open === false")
    check("help dialog closes", closed_state is True)


def run_demo_variant(browser, keep: bool = False) -> None:
    if keep:
        tmp_ctx = tempfile.TemporaryDirectory(prefix="flights-demo-")
        tmp_path = Path(tmp_ctx.name)
    else:
        tmp_ctx = None
        tmp_path = Path(tempfile.mkdtemp(prefix="flights-demo-"))
    try:
        mirror = tmp_path / "docs"
        shutil.copytree(DOCS, mirror, ignore=shutil.ignore_patterns("data"))
        (mirror / "data").mkdir(exist_ok=True)
        (mirror / "data" / "flights.json").write_text("{not json", encoding="utf8")
        with origin(mirror) as url:
            page = browser.new_page(viewport=VIEWPORT)
            page.on("pageerror", lambda err: page_errors.append(str(err)))
            page.goto(url + "/flights.html", wait_until="domcontentloaded")
            wait_until(
                lambda: page.locator("#status").get_attribute("data-state") == "demo",
                detail="demo status under corrupt snapshot",
            )
            summary = page.locator("#flights-summary").inner_text()
            check("demo fallback summary", "48 aircraft" in summary, f"summary='{summary}'")
            page.close()
    finally:
        if tmp_ctx is not None:
            tmp_ctx.cleanup()
        elif keep:
            print(f"(--keep) mirror left at {tmp_path}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0] if __doc__ else "Flights page end-to-end browser test"
    )
    parser.add_argument("--keep", action="store_true", help="keep the temp mirror for debugging")
    args = parser.parse_args()

    global browser  # noqa: PLW0603 - module scope for run_demo_variant
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()

        with origin(DOCS) as url:
            page = browser.new_page(viewport=VIEWPORT)
            page.on("pageerror", lambda err: page_errors.append(str(err)))
            run_live_checks(page, url)
            page.close()

        run_demo_variant(browser, keep=args.keep)
        browser.close()

    RESULTS.mkdir(parents=True, exist_ok=True)
    report_path = RESULTS / "flights-ui.json"
    report = {
        "generated_at": now_stamp(),
        "checks": checks,
        "findings": findings,
        "page_errors": page_errors,
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(f"\n{len(checks) - len(findings)}/{len(checks)} checks passed; report -> {report_path}")
    if page_errors:
        print("page errors captured:")
        for error in page_errors:
            print(f"  - {error[:200]}")
    return 1 if (findings or page_errors) else 0


if __name__ == "__main__":
    sys.exit(main())
