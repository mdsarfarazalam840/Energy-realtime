"""End-to-end browser test for the VoltScope Space (NASA APOD) page.

Serves the real `docs/` folder from `tests/load/serve_docs.mjs` and drives it
with Chromium through Playwright. The page fetches api.nasa.gov at runtime, so
the live path is exercised with route interception (including the image CORS
headers NASA sends), and the fallback paths are exercised by aborting the
upstream API and the fail-safe cache.

Usage:
    python tests/load/space_ui.py
    python tests/load/space_ui.py --keep

Exit code 1 when an assertion fails.
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO = Path(__file__).resolve().parents[2]
DOCS = REPO / "docs"
SERVER = Path(__file__).resolve().with_name("serve_docs.mjs")
RESULTS = Path(__file__).resolve().with_name("results")

DESKTOP = {"width": 1440, "height": 900}
TABLET = {"width": 1024, "height": 768}
MOBILE = {"width": 390, "height": 844}

API_HOST = "api.nasa.gov"
IMAGE_HOST = "images.example.com"
NASA_IMAGE_HOST = "assets.science.nasa.gov"

# One plate points at NASA's dynamic-image host so the test can prove the page
# asks for a smaller rendition instead of downloading the 1920px original.
NASA_PLATE_URL = (
    f"https://{NASA_IMAGE_HOST}/dynamicimage/assets/science/cds/apod/apod/2026/october/OrionSword_2000.jpg"
    "?w=1920&h=1200&fit=clip"
)

# 1x1 transparent PNG. Served for every stubbed APOD image so the WebGL texture
# path runs without touching the network.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

VIDEO_INDEX = 4

FAKE_TITLES = [
    "Stub Nebula Zero",
    "Stub Aurora One",
    "Stub Rings Two",
    "Stub Deep Field Three",
    "Stub Voyager Four",
    "Stub Terminator Five",
    "Stub Prominence Six",
    "Stub Halo Seven",
    "Stub Dust Devil Eight",
]

checks: list[dict] = []
findings: list[str] = []
image_requests: list[str] = []
api_requests: list[str] = []


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


def fake_entries() -> list[dict]:
    """Nine APOD entries ending today, with one video that has a thumbnail."""
    today = date.today()
    entries = []
    for index, title in enumerate(FAKE_TITLES):
        day = (today - timedelta(days=len(FAKE_TITLES) - 1 - index)).isoformat()
        media_type = "video" if index == VIDEO_INDEX else "image"
        entry = {
            "date": day,
            "title": title,
            "explanation": f"{title} is a synthetic APOD record used by the browser test to verify the observatory.",
            "media_type": media_type,
            "service_version": "v1",
            "url": f"https://{IMAGE_HOST}/{media_type}-{index}.png",
            "hdurl": f"https://{IMAGE_HOST}/{media_type}-{index}-hd.png",
            "copyright": "Test Astronomy Team",
        }
        if index == 2:
            entry["url"] = NASA_PLATE_URL
            entry["hdurl"] = NASA_PLATE_URL
        if media_type == "video":
            entry["url"] = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            entry["thumbnail_url"] = f"https://{IMAGE_HOST}/video-{index}.png"
            entry.pop("hdurl", None)
        entries.append(entry)
    return entries


def latest_entry() -> dict:
    return fake_entries()[-1]


def video_entry() -> dict:
    return fake_entries()[VIDEO_INDEX]


def cached_entries() -> list[dict]:
    today = date.today()
    return [
        {
            "date": (today - timedelta(days=offset)).isoformat(),
            "title": f"Cached Cassiopeia {offset}",
            "explanation": "A cached APOD record from the last committed snapshot.",
            "media_type": "image",
            "url": f"https://{IMAGE_HOST}/cached-{offset}.png",
            "hdurl": f"https://{IMAGE_HOST}/cached-{offset}-hd.png",
            "thumbnail_url": "",
            "copyright": "Cached Team",
        }
        for offset in range(5, -1, -1)
    ]


def prepare_site() -> Path:
    site = Path(tempfile.mkdtemp(prefix="voltscope-space-"))
    shutil.copytree(DOCS, site, dirs_exist_ok=True)
    # Synthetic fail-safe cache so the cached path has a deterministic payload.
    cache = {
        "schema_version": 1,
        "meta": {
            "source": "nasa-apod-cache",
            "count": 6,
            "image_count": 6,
            "video_count": 0,
            "first_date": cached_entries()[0]["date"],
            "latest_date": cached_entries()[-1]["date"],
            "cached_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
        "entries": cached_entries(),
        "demo": False,
    }
    (site / "data" / "apod.json").write_text(json.dumps(cache, indent=2), encoding="utf-8")
    return site


def route_image(route) -> None:
    image_requests.append(route.request.url)
    route.fulfill(
        status=200,
        content_type="image/png",
        headers={"Access-Control-Allow-Origin": "*"},
        body=PNG,
    )


def stub_images(page: Page) -> None:
    page.route(f"**://{IMAGE_HOST}/**", route_image)


def stub_apod(page: Page) -> None:
    """Intercept the NASA API and its image hosts (live path)."""
    payload = fake_entries()

    def route_api(route) -> None:
        api_requests.append(route.request.url)
        route.fulfill(
            status=200,
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
            body=json.dumps(payload),
        )

    page.route(f"**://{API_HOST}/**", route_api)
    stub_images(page)
    page.route(f"**://{NASA_IMAGE_HOST}/**", route_image)
    page.route("**://www.youtube.com/**", lambda route: route.abort())


def placeholder_entries() -> list[dict]:
    """Exactly what the upstream API returns when it has no real entry."""
    today = date.today()
    return [
        {
            "date": (today - timedelta(days=offset)).isoformat(),
            "title": "NASA Science",
            "explanation": "Discover the cosmos! Each day a different image or photograph of our fascinating universe is featured.",
            "media_type": "image",
            "service_version": "v1",
            "url": "https://science.nasa.gov/wp-content/themes/nasa-child/assets/images/nasa-logo@2x.png",
            "hdurl": "https://science.nasa.gov/wp-content/themes/nasa-child/assets/images/nasa-logo@2x.png",
        }
        for offset in range(8)
    ]


def stub_placeholder_api(page: Page) -> None:
    payload = placeholder_entries()

    def route_api(route) -> None:
        api_requests.append(route.request.url)
        route.fulfill(
            status=200,
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
            body=json.dumps(payload),
        )

    page.route(f"**://{API_HOST}/**", route_api)
    stub_images(page)


def block_apod(page: Page) -> None:
    """Abort the upstream NASA API to force a fallback path."""
    page.route(f"**://{API_HOST}/**", lambda route: route.abort())
    page.route(f"**://{IMAGE_HOST}/**", lambda route: route.abort())


def block_cache(page: Page) -> None:
    page.route("**/apod.json*", lambda route: route.abort())


def wait_loaded(page: Page, timeout: int = 25000) -> None:
    page.wait_for_selector("#day-strip .day-chip", timeout=timeout)
    page.wait_for_function("() => document.querySelector('#boot') === null", timeout=timeout)
    page.wait_for_timeout(500)


def collect_errors(page: Page, *, ignore_network: bool = False) -> list[str]:
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))

    def on_console(message) -> None:
        if message.type != "error":
            return
        text = message.text
        if ignore_network and (
            "Failed to load resource" in text
            or "404" in text
            or API_HOST in text
            or "ERR_FAILED" in text
        ):
            return
        errors.append(f"console error: {text}")

    page.on("console", on_console)
    return errors


def scene_canvas(page: Page) -> int:
    return page.locator("#scene canvas.scene-canvas").count()


def wait_for(predicate, timeout_ms: int = 8000, interval: float = 0.1) -> bool:
    """Poll a Python-side predicate (used for request-recording assertions)."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def chips(page: Page) -> list[dict]:
    return page.evaluate(
        """() => [...document.querySelectorAll('#day-strip .day-chip')].map((chip) => ({
            date: chip.dataset.date,
            selected: chip.getAttribute('aria-selected') === 'true',
            text: chip.innerText,
        }))"""
    )


def selected_date(page: Page) -> str:
    return page.evaluate(
        "() => document.querySelector('#day-strip .day-chip[aria-selected=\"true\"]')?.dataset.date || ''"
    )


def run_desktop(browser, url: str) -> None:
    print("\n[desktop] live APOD window (stubbed NASA API)")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page)
    image_requests.clear()
    api_requests.clear()
    stub_apod(page)
    page.goto(f"{url}/space.html", wait_until="networkidle")
    wait_loaded(page)
    page.wait_for_timeout(1200)

    check("page title mentions Space", "Space" in page.title(), page.title())
    check(
        "hero picture is loaded as a WebGL texture",
        any(latest_entry()["url"] in requested for requested in image_requests),
        f"{len(image_requests)} image requests",
    )

    # Performance budget: the orbit plates must not download (or upload) the
    # full-resolution original. NASA's dynamic-image host honours ?w=.
    rendition = wait_for(
        lambda: any(NASA_IMAGE_HOST in url and "w=460" in url for url in image_requests), 6000
    )
    check(
        "orbit plates request a small NASA rendition",
        rendition,
        next((url for url in image_requests if NASA_IMAGE_HOST in url), "no NASA image request"),
    )
    check(
        "full-resolution original is never fetched for the rail",
        not any(NASA_IMAGE_HOST in url and "w=1920" in url for url in image_requests),
        "; ".join(url for url in image_requests if NASA_IMAGE_HOST in url)[:160],
    )
    backing = page.evaluate(
        """() => {
            const canvas = document.querySelector('#scene canvas.scene-canvas');
            const rect = canvas.getBoundingClientRect();
            return { px: canvas.width * canvas.height, w: canvas.width, css: Math.round(rect.width) };
        }"""
    )
    check(
        "canvas backing store stays inside the pixel budget",
        backing["px"] <= 5_600_000 * 1.05,
        f"{backing['px']} px ({backing['w']} wide)",
    )
    check(
        "pixel ratio is capped at 2x",
        backing["w"] <= backing["css"] * 2 + 2,
        f"{backing['w']} backing / {backing['css']} css",
    )

    status = page.locator("#status-text").inner_text()
    check("status reports a live APOD feed", "NASA APOD" in status and "live" in status.lower(), status)

    latest = latest_entry()
    title = page.locator("#space-title").inner_text()
    check("hero panel shows the latest picture", title == latest["title"], title)
    check("hero date includes the year", latest["date"][:4] in page.locator("#space-date").inner_text())
    check(
        "explanation renders",
        "synthetic APOD record" in page.locator("#space-explanation").inner_text(),
    )
    check("media badge reads Image", page.locator("#space-media").inner_text().strip().lower() == "image", page.locator("#space-media").inner_text())
    check("full-resolution link targets the HD url", page.locator("#space-link").get_attribute("href") == latest["hdurl"])

    strip = chips(page)
    check("orbit index renders every frame", len(strip) == len(FAKE_TITLES), f"{len(strip)} chips")
    check("latest frame is selected", strip[-1]["selected"] and strip[-1]["date"] == latest["date"])
    check("rail note summarises the window", "9 frames" in page.locator("#rail-note").inner_text(), page.locator("#rail-note").inner_text())

    check("3D scene creates a WebGL canvas", scene_canvas(page) == 1)
    check("scene finished booting", page.locator("#scene-loading.is-done").count() == 1)

    # Pick the video entry from the orbit index.
    video = video_entry()
    page.click(f"#day-strip .day-chip[data-date='{video['date']}']")
    page.wait_for_timeout(300)
    check("clicking a chip focuses that frame", page.locator("#space-title").inner_text() == video["title"], page.locator("#space-title").inner_text())
    check("video badge switches", page.locator("#space-media").inner_text().strip().lower() == "video", page.locator("#space-media").inner_text())
    check("video link points at the video url", "youtube.com" in (page.locator("#space-link").get_attribute("href") or ""))
    check("video frame shows the watch label", "Watch" in page.locator("#space-link").inner_text())

    before = selected_date(page)
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(250)
    after = selected_date(page)
    check("arrow key steps to the next frame", after != before and after > before, f"{before} -> {after}")

    page.click("#btn-prev")
    page.wait_for_timeout(250)
    check("previous button steps back", selected_date(page) == before, selected_date(page))

    page.click("#camera-group button[data-camera='wide']")
    page.wait_for_timeout(200)
    check("camera preset keeps the canvas alive", scene_canvas(page) == 1)

    pressed = page.locator("#btn-orbit").get_attribute("aria-pressed")
    page.click("#btn-orbit")
    page.wait_for_timeout(150)
    check("orbit toggle flips", page.locator("#btn-orbit").get_attribute("aria-pressed") != pressed)
    page.click("#btn-orbit")

    page.click("#btn-theme")
    page.wait_for_timeout(250)
    check("theme toggles to light", page.locator("html").get_attribute("data-theme") == "light")
    check("scene still renders in light theme", scene_canvas(page) == 1)
    page.click("#btn-theme")
    page.wait_for_timeout(250)

    page.set_viewport_size({"width": 720, "height": 900})
    page.wait_for_timeout(700)
    check("resizing to the narrow layout keeps the scene alive", scene_canvas(page) == 1)
    page.set_viewport_size(DESKTOP)
    page.wait_for_timeout(500)
    check("resizing back to wide restores the scene", scene_canvas(page) == 1 and len(chips(page)) == len(FAKE_TITLES))

    check("share hash follows the selection", page.evaluate("() => location.hash") == f"#date={selected_date(page)}")

    # Browse every day: this exercises the bounded hero texture cache and the
    # per-day texture keys, which must not leak or blank the frame.
    for chip in chips(page):
        page.click(f"#day-strip .day-chip[data-date='{chip['date']}']")
        page.wait_for_timeout(120)
    page.wait_for_timeout(800)
    check(
        "browsing every day keeps the hero and canvas alive",
        scene_canvas(page) == 1 and page.locator("#space-title").inner_text() != "",
        page.locator("#space-title").inner_text(),
    )

    page.goto(f"{url}/space.html?api_key=TESTKEY123", wait_until="networkidle")
    wait_loaded(page)
    check(
        "api_key query parameter is forwarded to NASA",
        any("api_key=TESTKEY123" in requested for requested in api_requests),
        api_requests[-1] if api_requests else "no API request",
    )

    page.screenshot(path=str(RESULTS / "space-desktop.png"), full_page=True)
    check("no console or page errors on the live page", not errors, "; ".join(errors[:3]))
    context.close()


def run_mobile(browser, url: str) -> None:
    print("\n[mobile] responsive observatory")
    context = browser.new_context(viewport=MOBILE)
    page = context.new_page()
    errors = collect_errors(page)
    image_requests.clear()
    stub_apod(page)
    page.goto(f"{url}/space.html", wait_until="networkidle")
    wait_loaded(page)

    # The fanned rail is hidden below 1180px, so phones must not pay for its
    # photo downloads or GPU textures at all.
    check(
        "mobile skips orbit-rail photo downloads",
        not any("image-0.png" in requested for requested in image_requests),
        f"{len(image_requests)} image requests",
    )

    check("mobile index renders every frame", len(chips(page)) == len(FAKE_TITLES))
    check("mobile hero panel shows a title", page.locator("#space-title").inner_text() != "")
    check("mobile scene creates a WebGL canvas", scene_canvas(page) == 1)
    overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    check("mobile layout has no horizontal overflow", overflow <= 2, f"{overflow}px")
    panel = page.locator("#info-panel").bounding_box()
    check(
        "mobile panel stays inside the viewport",
        bool(panel) and panel["y"] >= 0 and panel["y"] + panel["height"] <= MOBILE["height"] + 1,
        str(panel),
    )
    page.screenshot(path=str(RESULTS / "space-mobile.png"), full_page=True)
    check("no console or page errors on mobile", not errors, "; ".join(errors[:3]))
    context.close()


def run_tablet(browser, url: str) -> None:
    print("\n[tablet] medium viewport")
    context = browser.new_context(viewport=TABLET)
    page = context.new_page()
    errors = collect_errors(page)
    stub_apod(page)
    page.goto(f"{url}/space.html", wait_until="networkidle")
    wait_loaded(page)

    check("tablet index renders every frame", len(chips(page)) == len(FAKE_TITLES))
    check("tablet scene creates a WebGL canvas", scene_canvas(page) == 1)
    overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    check("tablet layout has no horizontal overflow", overflow <= 2, f"{overflow}px")
    panel = page.locator("#info-panel").bounding_box()
    check(
        "tablet panel stays inside the viewport",
        bool(panel) and panel["y"] >= 0 and panel["x"] >= 0 and panel["x"] + panel["width"] <= TABLET["width"] + 1,
        str(panel),
    )
    page.click("#camera-group button[data-camera='close']")
    page.wait_for_timeout(200)
    check("tablet camera preset keeps the canvas alive", scene_canvas(page) == 1)
    page.screenshot(path=str(RESULTS / "space-tablet.png"), full_page=True)
    check("no console or page errors on tablet", not errors, "; ".join(errors[:3]))
    context.close()


def run_resilience(browser, url: str) -> None:
    """A lost WebGL context must degrade to a notice and recover, not go blank."""
    print("\n[resilience] WebGL context loss and recovery")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page)
    stub_apod(page)
    page.goto(f"{url}/space.html", wait_until="networkidle")
    wait_loaded(page)

    page.evaluate(
        """() => document.querySelector('#scene canvas')
            .dispatchEvent(new Event('webglcontextlost', { cancelable: true }))"""
    )
    page.wait_for_timeout(400)
    fallback = page.locator("#scene-fallback")
    check(
        "lost context shows a recoverable notice",
        fallback.is_visible() and "paused" in fallback.inner_text().lower(),
        fallback.inner_text().replace("\n", " ")[:80],
    )

    page.evaluate(
        "() => document.querySelector('#scene canvas')"
        ".dispatchEvent(new Event('webglcontextrestored'))"
    )
    page.wait_for_timeout(700)
    check("restored context hides the notice", not page.locator("#scene-fallback").is_visible())
    check("scene keeps a live canvas after recovery", scene_canvas(page) == 1)
    check("no console or page errors during recovery", not errors, "; ".join(errors[:3]))
    context.close()


def run_boot(browser, url: str) -> None:
    """The curtain must lift on the 3D scene, not on NASA's response."""
    print("\n[boot] first paint does not wait for the network")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page)
    # Park the API request forever: the page must still become usable.
    page.route(f"**://{API_HOST}/**", lambda route: None)
    page.route(f"**://{IMAGE_HOST}/**", route_image)
    page.goto(f"{url}/space.html", wait_until="domcontentloaded")

    lifted = True
    try:
        page.wait_for_function("() => document.querySelector('#boot') === null", timeout=4000)
    except Exception:  # noqa: BLE001 - the assertion below records the failure
        lifted = False
    check("boot curtain lifts while the API is still pending", lifted)
    check("3D stage is live before the data arrives", scene_canvas(page) == 1)
    check(
        "panel shows its loading state instead of stalling",
        "Loading the sky" in page.locator("#space-title").inner_text(),
        page.locator("#space-title").inner_text(),
    )
    check("no console or page errors while the API hangs", not errors, "; ".join(errors[:3]))
    context.close()


def run_fallback(browser, url: str, *, label: str) -> int:
    print(f"\n[fallback] {label}")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page, ignore_network=True)
    block_apod(page)
    block_cache(page)
    page.goto(f"{url}/space.html", wait_until="networkidle")
    wait_loaded(page)

    count = len(chips(page))
    check(f"{label}: demo orbit index renders", count >= 10, f"{count} chips")
    status = page.locator("#status-text").inner_text().lower()
    check(f"{label}: status reports demo", "demo" in status, status)
    check(f"{label}: demo title is populated", page.locator("#space-title").inner_text() not in ("", "—"))
    selected = selected_date(page)
    archive = f"https://apod.nasa.gov/apod/ap{selected[2:4]}{selected[5:7]}{selected[8:10]}.html"
    href = page.locator("#space-link").get_attribute("href") or ""
    check(f"{label}: frame links to the real NASA archive", href == archive, href)

    # The reported dead-end: clicking the 3D hero frame must open the archive
    # page for that date, not show a "no source link" toast.
    page.evaluate("() => { window.__opened = null; window.open = (url) => { window.__opened = url; return null; }; }")
    canvas = page.locator("#scene canvas").bounding_box()
    page.mouse.click(canvas["x"] + canvas["width"] / 2, canvas["y"] + canvas["height"] / 2)
    page.wait_for_timeout(300)
    opened = page.evaluate("() => window.__opened")
    check(f"{label}: clicking the 3D frame opens the NASA archive", opened == archive, str(opened))

    check(f"{label}: demo scene boots", scene_canvas(page) == 1)
    check(f"{label}: no console or page errors", not errors, "; ".join(errors[:3]))
    page.screenshot(path=str(RESULTS / f"space-{label}.png"), full_page=True)
    context.close()
    return count


def run_cache_fallback(browser, url: str) -> int:
    """Live API down but the committed fail-safe cache is available."""
    print("\n[fallback] cache (fail-safe cache)")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page, ignore_network=True)
    block_apod(page)  # live API down; cache file is left intact
    page.goto(f"{url}/space.html", wait_until="networkidle")
    wait_loaded(page)

    count = len(chips(page))
    status = page.locator("#status-text").inner_text().lower()
    title = page.locator("#space-title").inner_text()
    check("cache: orbit index renders from cache", count == 6, f"{count} chips")
    check("cache: status reports cached", "cached" in status, status)
    check("cache: status is not demo", "demo" not in status, status)
    check("cache: cached picture is shown", "Cached Cassiopeia" in title, title)
    check("cache: scene boots on cached data", scene_canvas(page) == 1)
    check("cache: no console or page errors", not errors, "; ".join(errors[:3]))
    page.screenshot(path=str(RESULTS / "space-cache.png"), full_page=True)
    context.close()
    return count


def run_placeholder_fallback(browser, url: str) -> int:
    """The API is up but only returns placeholder "NASA Science" records."""
    print("\n[fallback] placeholder API records (real cache)")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    errors = collect_errors(page)
    api_requests.clear()
    stub_placeholder_api(page)
    page.goto(f"{url}/space.html", wait_until="networkidle")
    wait_loaded(page)

    count = len(chips(page))
    status = page.locator("#status-text").inner_text().lower()
    title = page.locator("#space-title").inner_text()
    check("placeholder: API was called", len(api_requests) >= 1, f"{len(api_requests)} calls")
    check("placeholder: page falls back to the cache", count == 6 and "cached" in status, f"{count} chips / {status}")
    check("placeholder: logo record is not shown", title != "NASA Science" and "Cached Cassiopeia" in title, title)
    check("placeholder: scene boots on cached data", scene_canvas(page) == 1)
    check("placeholder: no console or page errors", not errors, "; ".join(errors[:3]))
    context.close()
    return count


def run_navigation(browser, url: str) -> None:
    print("\n[navigation] links between dashboards")
    context = browser.new_context(viewport=DESKTOP)
    page = context.new_page()
    for path, label in (("index.html", "energy"), ("crypto.html", "crypto"), ("finance.html", "finance"), ("tech.html", "tech")):
        page.goto(f"{url}/{path}", wait_until="domcontentloaded")
        check(f"{label} page links to space", page.locator("a[href='space.html']").count() >= 1, path)
    page.goto(f"{url}/space.html", wait_until="domcontentloaded")
    check("space page links back to energy", page.locator("a[href='index.html']").count() >= 1)
    check("space page links to tech", page.locator("a[href='tech.html']").count() >= 1)
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
                    run_tablet(browser, url)
                    run_mobile(browser, url)
                    run_resilience(browser, url)
                    run_boot(browser, url)
                    demo_count = run_fallback(browser, url, label="demo")
                    check("demo fallback renders a full gallery", demo_count >= 10, f"{demo_count} chips")
                    cache_count = run_cache_fallback(browser, url)
                    check("cache fallback renders the cached gallery", cache_count == 6, f"{cache_count} chips")
                    placeholder_count = run_placeholder_fallback(browser, url)
                    check("placeholder fallback keeps the cached gallery", placeholder_count == 6, f"{placeholder_count} chips")
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
    (RESULTS / "space-ui.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"\n{payload['passed']} passed, {payload['failed']} failed")
    if findings:
        print("\nFindings:")
        for finding in findings:
            print(f"  - {finding}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
