#!/usr/bin/env python3
"""PreToolUse guard - an oversized or wrong-format image is caught BEFORE it is loaded (LC-1883).

WHY. On 2026-10-21 Ahrefs flagged a 3 MB uncompressed JPEG hero on
/blog/best-kid-pet-friendly-sofas. Cards and slots already go through
generated-image-intake (800px WebP under 95 KB), but the article hero had no intake
target, so a session set it straight from the generator's JPEG and nothing checked.
Stan: "This should be caught prior to loading the image/s not after the fact and rework."

WHAT. Reads every image a Webflow write is about to load and probes its headers:

  * data_cms_tool  create_collection_items / update_collection_items - image values in the
    items' fieldData: an object with a "url" (and only image keys url/alt/fileId), a URL
    string whose path ends in an image extension or whose field name says image
    (image, photo, thumbnail, hero, logo, icon, avatar, banner, cover), and <img src> in
    HTML strings (rich text).
  * asset_tool     upload_image_by_url - the action's `url`.

Per image: HEAD, falling back to a ranged GET (Range: bytes=0-0, size from Content-Range).

  BLOCK  Content-Length > 400 KB, or content-type not image/webp, image/avif, image/svg+xml.
  ASK    size or type cannot be determined (probe failed, no Content-Length, no Content-Type,
         non-http(s) or relative URL, over the 40-image cap, probe out of time). Never a
         silent pass: NOT CHECKED is not PASS.
  ALLOW  silent. A payload with no image, a non-image field, or every image within budget.

BLOCK beats ASK when both occur. Other actions of the same tool (list, publish, delete,
field changes) are not inspected.

Not covered: images already stored in Webflow that a write only references by fileId
(no url to probe); Designer-API image tools; data_assets_tool; a URL whose headers lie.
The probe runs from the session container, so a URL only reachable from elsewhere asks.

Self-test: python3 image-weight-guard.py --selftest
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MOD = "[mod:image-weight-guard]"
MAX_BYTES = 400 * 1024
ALLOWED_TYPES = ("image/webp", "image/avif", "image/svg+xml")
MAX_IMAGES = 40          # a payload with more is NOT CHECKED beyond this, so it asks
PROBE_TIMEOUT_S = 3      # per request; HEAD then ranged GET = 6 s worst case per image
DEADLINE_S = 6.5         # whole check; the mod runs this under a 10 s process timeout
IMAGE_KEYS = {"url", "alt", "fileId", "id"}
IMAGE_EXT = re.compile(r"\.(?:jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic)$", re.I)
# Matched against whole name tokens, never substrings: "coverage", "iconic" and "logotype"
# are not image fields (CI review on #1984 caught "coverage" blocking an HTML link).
IMAGE_FIELD_WORDS = frozenset({"image", "images", "img", "photo", "photos", "thumbnail",
                               "thumbnails", "hero", "logo", "logos", "icon", "icons",
                               "avatar", "avatars", "banner", "banners", "cover", "covers"})
FIELD_TOKEN_SPLIT = re.compile(r"[-_\s.]+|(?<=[a-z0-9])(?=[A-Z])")
IMG_SRC = re.compile(r"<img\b[^>]*?\bsrc\s*=\s*[\"']([^\"']+)[\"']", re.I)
CMS_ACTIONS = ("create_collection_items", "update_collection_items")
FIX = ("Fix: route the image through generated-image-intake "
       "(webflow/bulk-operations/generated-image-intake: target article_hero for a Blog Post "
       "main-image, product_card, bpd_slot), or compress it to WebP under 400 KB first, then "
       "write the self-hosted R2 URL.")


# --- finding the images in a payload (pure) -------------------------------------------------
def _image_field(key: str) -> bool:
    """True when a field NAME says image: a slug, snake or camelCase token is an image word."""
    return any(t.lower() in IMAGE_FIELD_WORDS for t in FIELD_TOKEN_SPLIT.split(key) if t)


def _is_url(v: object) -> bool:
    return isinstance(v, str) and urllib.parse.urlparse(v.strip()).scheme in ("http", "https")


def _walk(node: object, key: str, out: list[str]) -> None:
    if isinstance(node, dict):
        u = node.get("url")
        if isinstance(u, str) and set(node) <= IMAGE_KEYS:
            out.append(u.strip())          # an image object; its url is judged whatever it looks like
            return
        for k, v in node.items():
            _walk(v, str(k), out)
    elif isinstance(node, list):
        for v in node:
            _walk(v, key, out)
    elif isinstance(node, str):
        out.extend(m.strip() for m in IMG_SRC.findall(node))
        s = node.strip()
        if _is_url(s) and (IMAGE_EXT.search(urllib.parse.urlparse(s).path) or _image_field(key)):
            out.append(s)


def _actions(tool_input: dict) -> list | None:
    acts = tool_input.get("actions")
    if isinstance(acts, str):
        try:
            acts = json.loads(acts)
        except ValueError:
            return None
    return acts if isinstance(acts, list) else None


def image_urls(tool_name: str, tool_input: dict) -> list[str] | None:
    """Every image URL the call would load, in order, de-duplicated. None = payload unreadable."""
    low = (tool_name or "").lower()
    acts = _actions(tool_input)
    if acts is None:
        return None
    found: list[str] = []
    for a in acts:
        if not isinstance(a, dict):
            continue
        if low.endswith("__asset_tool") or low == "asset_tool":
            up = a.get("upload_image_by_url")
            if isinstance(up, dict):
                found.append(str(up.get("url") or "").strip())
        elif low.endswith("__data_cms_tool") or low == "data_cms_tool":
            for act in CMS_ACTIONS:
                body = a.get(act)
                if isinstance(body, dict):
                    _walk(body.get("request"), "", found)
    seen: set[str] = set()
    return [u for u in found if not (u in seen or seen.add(u))]


# --- probing (the only I/O; replaced in the selftest) ---------------------------------------
def probe(url: str) -> tuple[int | None, str | None, str | None]:
    """(bytes, content_type, problem). Problem is set when size or type is unknown."""
    if not _is_url(url):
        return None, None, "not an absolute http(s) URL, so it cannot be probed"
    head_err = ""
    for method, extra in (("HEAD", {}), ("GET", {"Range": "bytes=0-0"})):
        try:
            req = urllib.request.Request(url, method=method, headers={
                "User-Agent": "bbm-image-weight-guard/1.0", **extra})
            with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT_S) as r:
                size = _size_of(r.headers)
                ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower() or None
                if size is not None and ctype:
                    return size, ctype, None
                head_err = f"{method} gave no {'Content-Length' if size is None else 'Content-Type'}"
        except urllib.error.HTTPError as e:
            head_err = f"{method} answered HTTP {e.code}"
        except Exception as e:  # noqa: BLE001 - a failed probe is data
            head_err = f"{method} failed ({str(e)[:60]})"
    return None, None, head_err or "no answer"


def _size_of(headers) -> int | None:
    cr = headers.get("Content-Range") or ""
    m = re.search(r"/(\d+)\s*$", cr)
    if m:
        return int(m.group(1))
    cl = headers.get("Content-Length")
    return int(cl) if cl and cl.isdigit() else None


# --- verdict --------------------------------------------------------------------------------
def _kb(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB" if n >= 1024 * 1024 else f"{n // 1024} KB"


def judge(url: str, size: int | None, ctype: str | None, problem: str | None) -> tuple[str, str]:
    """('pass'|'block'|'ask', reason) for one image."""
    if problem or size is None or not ctype:
        return "ask", f"{url}: size/type unknown ({problem or 'headers incomplete'})"
    bad = []
    if size > MAX_BYTES:
        bad.append(f"{_kb(size)} exceeds the {_kb(MAX_BYTES)} budget")
    if ctype not in ALLOWED_TYPES:
        bad.append(f"{ctype} is not WebP/AVIF/SVG")
    if bad:
        return "block", f"{url}: {'; '.join(bad)}"
    return "pass", ""


def evaluate(tool_name: str, tool_input: dict, probe_fn=None, deadline: float = DEADLINE_S) -> tuple[str, str] | None:
    low = (tool_name or "").lower()
    if not (low.startswith("mcp__") or "__" not in low) or not (
            low.endswith("data_cms_tool") or low.endswith("asset_tool")):
        return None
    urls = image_urls(tool_name, tool_input)
    if urls is None:
        return "ask", (f"{MOD} NOT CHECKED: the call's `actions` could not be read, so its images were "
                       "not examined. Confirm only if no image is being loaded.")
    probe_fn = probe_fn or probe
    unchecked = urls[MAX_IMAGES:]
    urls = urls[:MAX_IMAGES]
    results: dict[str, tuple] = {}
    ex = concurrent.futures.ThreadPoolExecutor(max_workers=8)
    try:
        futs = {ex.submit(probe_fn, u): u for u in urls}
        done, _ = concurrent.futures.wait(futs, timeout=deadline)
        for f, u in futs.items():
            if f in done and not f.exception():
                results[u] = f.result()
    finally:
        ex.shutdown(wait=False)  # a straggling probe must not hold the verdict back
    blocks: list[str] = []
    asks: list[str] = []
    for u in urls:
        verdict, why = judge(u, *(results.get(u) or (None, None, "probe timed out or crashed")))
        (blocks if verdict == "block" else asks if verdict == "ask" else []).append(why)
    asks += [f"{u}: over the {MAX_IMAGES}-image cap, not examined" for u in unchecked]
    if blocks:
        return "deny", (f"{MOD} BLOCKED: {len(blocks)} image(s) would be loaded into Webflow over the weight "
                        "budget or in the wrong format:\n- " + "\n- ".join(blocks[:8])
                        + (f"\n(+{len(blocks) - 8} more)" if len(blocks) > 8 else "")
                        + (f"\nAlso NOT CHECKED: {len(asks)} image(s)." if asks else "") + "\n" + FIX)
    if asks:
        return "ask", (f"{MOD} NOT CHECKED: image weight could not be determined for {len(asks)} image(s); "
                       "approve only if you know they are WebP/AVIF/SVG under 400 KB:\n- "
                       + "\n- ".join(asks[:8]) + "\n" + FIX)
    return None


def emit(decision: str, reason: str) -> None:
    json.dump({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }}, sys.stdout)
    sys.stdout.write("\n")


# --- selftest -------------------------------------------------------------------------------
def _selftest() -> int:
    checks = fails = 0

    def ck(cond: bool, label: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            sys.stderr.write(f"  FAIL: {label}\n")

    CMS = "mcp__Webflow__data_cms_tool"
    ASSET = "mcp__Webflow__asset_tool"
    HEAD = {  # stubbed HEAD answers: url -> (bytes, content-type, problem)
        "https://x/jpeg3mb.jpg": (3 * 1024 * 1024, "image/jpeg", None),
        "https://x/ok330.webp": (330 * 1024, "image/webp", None),
        "https://x/big450.webp": (450 * 1024, "image/webp", None),
        "https://x/logo.svg": (12 * 1024, "image/svg+xml", None),
        "https://x/edge400.webp": (400 * 1024, "image/webp", None),
        "https://x/edge401.webp": (400 * 1024 + 1, "image/webp", None),
        "https://x/small.png": (20 * 1024, "image/png", None),
        "https://x/avif.avif": (90 * 1024, "image/avif", None),
        "https://x/nolen.webp": (None, "image/webp", "HEAD gave no Content-Length"),
        "https://x/notype.webp": (1000, None, "HEAD gave no Content-Type"),
        "https://x/dead.webp": (None, None, "HEAD failed (timed out)"),
        "https://x/page": (50 * 1024, "text/html", None),
        "https://x/heroshot": (3 * 1024 * 1024, "image/jpeg", None),
    }
    calls: list[str] = []

    def stub(u: str):
        calls.append(u)
        return HEAD[u]

    def cms(field_data: dict, action: str = "create_collection_items") -> dict:
        body = {"collection_id": "c", "request": {"items": [{"fieldData": field_data}]}}
        return {"actions": [{"label": "l", action: body}]}

    def asset(url: str) -> dict:
        return {"siteId": "s", "actions": [{"label": "l", "upload_image_by_url": {"url": url}}]}

    def v(tool: str, inp: dict) -> str | None:
        r = evaluate(tool, inp, stub)
        return r[0] if r else None

    # the seven required cases, on the CMS path
    r = evaluate(CMS, cms({"name": "a", "main-image": {"url": "https://x/jpeg3mb.jpg", "alt": "t"}}), stub)
    ck(r is not None and r[0] == "deny", "3 MB jpeg object -> block")
    ck(r is not None and r[1].startswith("[mod:image-weight-guard]"), "block message starts with the mod callout")
    ck(r is not None and "3.0 MB" in r[1] and "image/jpeg" in r[1], "block names size and type")
    ck(r is not None and all(w in r[1] for w in ("generated-image-intake", "article_hero", "product_card",
                                                  "bpd_slot", "WebP", "400 KB")), "block message carries the fix")
    ck(v(CMS, cms({"main-image": {"url": "https://x/ok330.webp", "alt": "t"}})) is None, "330 KB webp -> allow")
    ck(v(CMS, cms({"main-image": {"url": "https://x/big450.webp", "alt": "t"}})) == "deny", "450 KB webp -> block")
    ck(v(CMS, cms({"brand-logo": {"url": "https://x/logo.svg"}})) is None, "svg logo -> allow")
    # field-name hints match whole tokens only (CI review on #1984, finding 1)
    for name in ("coverage", "iconic", "logotype", "heroic-quote"):
        ck(v(CMS, cms({name: "https://x/page"})) is None, f"non-image field {name!r} with a page url -> allow")
    for name in ("cover", "cover-image", "hero_image", "heroImage", "thumbnailUrl", "Brand Logo", "images"):
        ck(v(CMS, cms({name: "https://x/heroshot"})) == "deny", f"image field {name!r}, no extension -> probed, block")
    r = evaluate(CMS, cms({"main-image": {"url": "https://x/dead.webp"}}), stub)
    ck(r is not None and r[0] == "ask" and r[1].startswith("[mod:image-weight-guard]"), "unknown size -> ask")
    ck(v(CMS, cms({"name": "t", "slug": "s", "meta-description": "see https://x/jpeg3mb.jpg is big",
                   "word-count": 4, "is-featured": True, "product-link": "https://go.livingcozy.com/abc"})) is None
       and calls.count("https://x/jpeg3mb.jpg") == 1, "non-image fields untouched, never probed")
    calls.clear()
    ck(v(CMS, cms({"name": "t", "slug": "s"})) is None and not calls, "payload with no image -> allow, no probe")

    # boundary: the budget is > 400 KB, not >=
    ck(v(CMS, cms({"main-image": {"url": "https://x/edge400.webp"}})) is None, "exactly 400 KB passes")
    ck(v(CMS, cms({"main-image": {"url": "https://x/edge401.webp"}})) == "deny", "400 KB + 1 byte blocks")
    # type rule alone (small png), and avif allowed
    ck(v(CMS, cms({"main-image": {"url": "https://x/small.png"}})) == "deny", "small png blocks on type")
    ck(v(CMS, cms({"main-image": {"url": "https://x/avif.avif"}})) is None, "avif allowed")
    # missing size / type each ask
    ck(v(CMS, cms({"main-image": {"url": "https://x/nolen.webp"}})) == "ask", "no Content-Length -> ask")
    ck(v(CMS, cms({"main-image": {"url": "https://x/notype.webp"}})) == "ask", "no Content-Type -> ask")
    # shapes
    ck(v(CMS, cms({"gallery": [{"url": "https://x/ok330.webp"}, {"url": "https://x/jpeg3mb.jpg"}]})) == "deny",
       "MultiImage list: one bad image blocks")
    ck(v(CMS, cms({"featured-image": "https://x/jpeg3mb.jpg"})) == "deny", "image URL string in an image field")
    ck(v(CMS, cms({"anything": "https://x/jpeg3mb.jpg"})) == "deny", "image-extension URL string in any field")
    ck(v(CMS, cms({"post-body": '<p><img src="https://x/jpeg3mb.jpg" alt="x"></p>'})) == "deny", "rich text <img src>")
    ck(v(CMS, cms({"post-body": '<p><img src="/relative.jpg"></p>'})) == "ask", "relative <img src> -> ask")
    ck(v(CMS, cms({"related": {"url": "https://go.livingcozy.com/abc", "label": "a link"}})) is None
       and not calls[-1:] == ["https://go.livingcozy.com/abc"],
       "object with non-image keys is not an image object")
    ck(v(CMS, cms({"main-image": {"url": "ftp://x/a.webp"}})) == "ask", "non-http image url -> ask")
    ck(v(CMS, cms({"main-image": {"url": "https://x/jpeg3mb.jpg"}}, "update_collection_items")) == "deny",
       "update_collection_items is checked")
    legacy = {"actions": [{"label": "l", "create_collection_items": {
        "collection_id": "c", "request": {"fieldData": [{"name": "a", "slug": "a",
                                                          "main-image": {"url": "https://x/jpeg3mb.jpg"}}]}}}]}
    ck(v(CMS, legacy) == "deny", "deprecated request.fieldData list is checked")
    ck(v(CMS, {"actions": json.dumps(cms({"main-image": {"url": "https://x/jpeg3mb.jpg"}})["actions"])}) == "deny",
       "stringified actions are read")
    ck(v(CMS, {"actions": "{not json"}) == "ask", "unreadable actions -> ask, not a pass")
    ck(v(CMS, {"actions": [{"label": "l", "publish_collection_items": {
        "collection_id": "c", "request": {"items": [{"id": "https://x/jpeg3mb.jpg"}]}}}]}) is None,
       "other CMS actions are not inspected")
    # mixed: block beats ask; dedupe probes
    calls.clear()
    r = evaluate(CMS, cms({"a-image": {"url": "https://x/jpeg3mb.jpg"}, "b-image": {"url": "https://x/dead.webp"},
                           "c-image": {"url": "https://x/jpeg3mb.jpg"}}), stub)
    ck(r is not None and r[0] == "deny" and "NOT CHECKED: 1" in r[1], "block beats ask and still reports the unchecked")
    ck(calls.count("https://x/jpeg3mb.jpg") == 1, "a repeated url is probed once")

    # asset_tool
    ck(v(ASSET, asset("https://x/jpeg3mb.jpg")) == "deny", "asset upload of a 3 MB jpeg blocks")
    ck(v(ASSET, asset("https://x/ok330.webp")) is None, "asset upload of a 330 KB webp allows")
    ck(v(ASSET, asset("https://x/dead.webp")) == "ask", "asset upload with unknown size asks")
    ck(v("mcp__Other__asset_tool", asset("https://x/jpeg3mb.jpg")) == "deny", "any server name exposing asset_tool")
    ck(v("mcp__Webflow2__data_cms_tool", cms({"main-image": {"url": "https://x/jpeg3mb.jpg"}})) == "deny",
       "any server name exposing data_cms_tool")
    ck(v("mcp__Webflow__data_pages_tool", cms({"main-image": {"url": "https://x/jpeg3mb.jpg"}})) is None,
       "other tools are not this guard's")
    ck(v("Bash", {"command": "ls"}) is None, "Bash untouched")

    # cap and crash/timeouts never pass silently
    many = {f"i{n}-image": {"url": "https://x/ok330.webp"} for n in range(3)}
    ck(v(CMS, cms(many)) is None, "several good images allow")
    over = {f"i{n}-image": {"url": f"https://x/n{n}.webp"} for n in range(MAX_IMAGES + 2)}
    big = {**HEAD, **{f"https://x/n{n}.webp": (1000, "image/webp", None) for n in range(MAX_IMAGES + 2)}}
    r = evaluate(CMS, cms(over), lambda u: big[u])
    ck(r is not None and r[0] == "ask" and "image cap" in r[1], "over the image cap -> ask for the rest")

    def boom(u: str):
        raise RuntimeError("probe crashed")
    r = evaluate(CMS, cms({"main-image": {"url": "https://x/ok330.webp"}}), boom)
    ck(r is not None and r[0] == "ask", "a crashing probe asks, never passes")

    # judge() directly
    ck(judge("u", 1, "image/webp", None)[0] == "pass", "judge pass")
    ck(judge("u", None, "image/webp", None)[0] == "ask", "judge: no size asks")
    ck(judge("u", 1, "image/webp", "boom")[0] == "ask", "judge: problem asks")

    # header parsing for the ranged-GET fallback
    class H(dict):
        def get(self, k, d=None):
            return super().get(k, d)
    ck(_size_of(H({"Content-Range": "bytes 0-0/3145728"})) == 3145728, "size from Content-Range")
    ck(_size_of(H({"Content-Length": "2048"})) == 2048, "size from Content-Length")
    ck(_size_of(H({"Content-Range": "bytes 0-0/3145728", "Content-Length": "1"})) == 3145728,
       "Content-Range wins over the 1-byte Content-Length")
    ck(_size_of(H({})) is None, "no length header -> None")
    ck(probe("/relative.jpg")[2] is not None, "probe: relative url is a problem, not a size")

    # _is_url and image_urls edge shapes
    ck(_is_url("https://x") and _is_url(" http://x ") and not _is_url("ftp://x")
       and not _is_url(None) and not _is_url(5) and not _is_url("/rel"), "_is_url")
    ck(v(CMS, {"actions": ["junk", None, cms({"m-image": {"url": "https://x/jpeg3mb.jpg"}})["actions"][0]]}) == "deny",
       "non-dict actions are skipped, the dict one is still judged")
    ck(image_urls("asset_tool", asset("https://x/a.webp")) == ["https://x/a.webp"], "bare asset_tool name")
    ck(image_urls("data_cms_tool", cms({"m-image": {"url": "https://x/a.webp"}})) == ["https://x/a.webp"],
       "bare data_cms_tool name")
    ck(evaluate("data_cms_tool", cms({"m-image": {"url": "https://x/jpeg3mb.jpg"}}), stub)[0] == "deny",
       "bare data_cms_tool name is judged")
    ck(evaluate("foo__data_cms_tool", cms({"m-image": {"url": "https://x/jpeg3mb.jpg"}}), stub) is None,
       "a name without mcp__ and with __ is not ours")
    ck(image_urls("mcp__W__asset_tool", cms({"m-image": {"url": "https://x/a.webp"}})) == [],
       "asset_tool ignores CMS-shaped actions")
    ck(image_urls("mcp__W__data_cms_tool", asset("https://x/a.webp")) == [],
       "data_cms_tool ignores upload-shaped actions")
    # more than 8 blocked images: 8 listed, the rest counted
    HEAD.update({f"https://x/b{n}.jpg": (3 * 1024 * 1024, "image/jpeg", None) for n in range(10)})
    r = evaluate(CMS, cms({f"i{n}-image": {"url": f"https://x/b{n}.jpg"} for n in range(10)}), stub)
    ck(r is not None and r[1].count("\n- ") == 8 and "(+2 more)" in r[1] and "10 image(s)" in r[1],
       "block list is capped at 8 with a count of the rest")
    ck(evaluate(CMS, cms({"m-image": {"url": "https://x/jpeg3mb.jpg"}}), stub)[1].count("NOT CHECKED") == 0,
       "a clean block does not mention unchecked images")
    # a straggling probe: the verdict is an ask and arrives at the deadline, not when the probe ends
    def slow(u: str):
        time.sleep(1.5)
        return HEAD["https://x/ok330.webp"]
    t0 = time.monotonic()
    r = evaluate(CMS, cms({"m-image": {"url": "https://x/ok330.webp"}}), slow, deadline=0.2)
    took = time.monotonic() - t0
    ck(r is not None and r[0] == "ask" and "timed out" in r[1] and took < 1.0, "a probe past the deadline asks without waiting")
    # a probe that answers inside the deadline is used
    ck(evaluate(CMS, cms({"m-image": {"url": "https://x/ok330.webp"}}), stub, deadline=5) is None, "fast probe inside the deadline")

    # probe(): real code path against a faked urllib (no network)
    import io
    real_urlopen = urllib.request.urlopen

    class Resp:
        def __init__(self, headers: dict):
            self.headers = headers

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def faked(script: dict):
        seen: list[tuple] = []

        def fake(req, timeout=None):
            seen.append((req.get_method(), req.get_header("Range"), timeout))
            out = script[req.get_method()]
            if isinstance(out, Exception):
                raise out
            return Resp(out)
        return fake, seen

    try:
        f, seen = faked({"HEAD": {"Content-Length": "3145728", "Content-Type": "Image/JPEG; charset=x"}})
        urllib.request.urlopen = f
        ck(probe("https://x/a") == (3145728, "image/jpeg", None) and [s_[0] for s_ in seen] == ["HEAD"]
           and seen[0][2] == PROBE_TIMEOUT_S, "probe: HEAD answer, type normalised, no GET")
        f, seen = faked({"HEAD": urllib.error.HTTPError("https://x/a", 405, "no", {}, io.BytesIO()),
                         "GET": {"Content-Range": "bytes 0-0/2097152", "Content-Length": "1", "Content-Type": "image/png"}})
        urllib.request.urlopen = f
        ck(probe("https://x/a") == (2097152, "image/png", None) and [s_[0] for s_ in seen] == ["HEAD", "GET"]
           and seen[1][1] == "bytes=0-0", "probe: HEAD refused -> ranged GET, size from Content-Range")
        f, seen = faked({"HEAD": {"Content-Type": "image/webp"}, "GET": {"Content-Length": "500", "Content-Type": "image/webp"}})
        urllib.request.urlopen = f
        ck(probe("https://x/a") == (500, "image/webp", None), "probe: HEAD without a length -> GET supplies it")
        f, seen = faked({"HEAD": {"Content-Length": "500"}, "GET": {"Content-Length": "500", "Content-Type": "image/webp"}})
        urllib.request.urlopen = f
        ck(probe("https://x/a") == (500, "image/webp", None), "probe: HEAD without a type -> GET supplies it")
        f, seen = faked({"HEAD": {"Content-Length": "500"}, "GET": {"Content-Length": "500"}})
        urllib.request.urlopen = f
        r_ = probe("https://x/a")
        ck(r_[0] is None and r_[1] is None and "Content-Type" in r_[2], "probe: no type anywhere -> problem names it")
        f, seen = faked({"HEAD": {"Content-Type": "image/webp"}, "GET": {"Content-Type": "image/webp"}})
        urllib.request.urlopen = f
        r_ = probe("https://x/a")
        ck(r_[0] is None and "Content-Length" in r_[2], "probe: no length anywhere -> problem names it")
        f, seen = faked({"HEAD": OSError("boom"), "GET": urllib.error.HTTPError("https://x/a", 403, "no", {}, io.BytesIO())})
        urllib.request.urlopen = f
        r_ = probe("https://x/a")
        ck(r_[0] is None and r_[1] is None and "403" in r_[2], "probe: both fail -> the last problem is reported")
        f, seen = faked({"HEAD": {"Content-Length": "12x", "Content-Type": "image/webp"},
                         "GET": {"Content-Length": "12x", "Content-Type": "image/webp"}})
        urllib.request.urlopen = f
        ck(probe("https://x/a")[0] is None, "probe: a non-numeric length is not a size")
        seen.clear()
        ck(probe("file:///etc/passwd")[0] is None and not seen, "probe: a non-http url is never opened")
    finally:
        urllib.request.urlopen = real_urlopen

    # main(): stdin protocol, fail open and visible on junk
    import subprocess
    me = [sys.executable, "-I", __file__]

    def run(stdin: str):
        p = subprocess.run(me, input=stdin, capture_output=True, text=True)
        return p.returncode, p.stdout, p.stderr
    rc, out, _ = run(json.dumps({"tool_name": ASSET, "tool_input": asset("/relative.jpg")}))
    ck(rc == 0 and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "ask", "main(): asks on an unprobeable url")
    rc, out, _ = run(json.dumps({"tool_name": CMS, "tool_input": cms({"name": "x"})}))
    ck(rc == 0 and out == "", "main(): no image is silent")
    rc, out, _ = run(json.dumps({"tool_name": CMS, "tool_input": "str"}))
    ck(rc == 0 and json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "ask",
       "main(): a non-dict tool_input is treated as empty and asks (unreadable), not a pass")
    rc, out, err = run("{not json")
    ck(rc == 1 and out == "" and "allowing" in err, "main(): junk input fails open and visible")
    rc, out, _ = run("")
    ck(rc == 0 and out == "", "main(): empty stdin is silent")

    print(f"image-weight-guard selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return _selftest()
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
        tool_input = payload.get("tool_input") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}
        verdict = evaluate(payload.get("tool_name") or "", tool_input)
    except Exception as e:  # noqa: BLE001
        # Fail OPEN and visible, like the sibling guards.
        sys.stderr.write(f"image-weight-guard: could not evaluate ({e}); allowing the call. "
                         "The guard is not protecting this one.\n")
        return 1
    if verdict:
        emit(*verdict)
    return 0


if __name__ == "__main__":
    rc = main()
    sys.stdout.flush()
    sys.stderr.flush()
    # Straggling probe threads would otherwise keep the process alive past the mod's 10 s
    # process timeout, and a killed check reads as silence (fail open). The verdict is out.
    os._exit(rc)
