#!/usr/bin/env python3
"""catalog_publish.py — may this Products / Brands publish go out? (LC-2297)

WHY THIS EXISTS. Operator decision (2026-11-19, repeated 2026-11-20): Catalog & Prices (LC-429)
publishes the Webflow Products and Brands items itself, once each one is verified correct,
complete and current. refresh-run-guard denied EVERY publish_collection_items call ("publishing
is a human click"), so that decision had no allowed path and the publish fell back to the
operator's own click (LC-2293, deep sofas). Articles (Blog Posts, Best Products Data) stay a
human click behind Pass A; this file never sees them.

WHAT IT DECIDES. register.ts calls this ONLY for a call whose every action is exactly
`publish_collection_items` on the Products or Brands collection id. For each item it writes one
receipt, PASS / BLOCK / NOT CHECKED with the reason, and the call is allowed only when EVERY
receipt is PASS. NOT CHECKED never counts as a pass.

  Products  the item's staged fieldData, as THIS session read it from Webflow after its last
            write, passes webflow/bulk-operations/_shared/product_readiness.py product_gaps()
            with the Supabase context (review, sale, family) from the canonical read below,
            and products.price_verified_at is under 24 hours old.
  Brands    the staged fieldData has name, brand-url, full-size-image and full-size-image-alt-text,
            the alt text is not the bare brand name; brand-logo set needs its own alt text (not
            the name); discount-available on is judged by the article audit's own
            brand_discount_rule.findings() (LC-2129, LC-2370): discount-message always, the
            discount code only when the message tells the reader to use one
            (article-technical-audit §4b, the REQ / COND rows a publish can break).
  Both      the Webflow read is under 60 minutes old and the item is not archived.

WHAT IT CANNOT SEE. A hook has no Webflow or Supabase credential (LC-1017, by decision), so it
judges what the session READ: register.ts records Webflow item reads and the one canonical
Supabase read (CONTEXT_SQL in register.ts, matched exactly). product_readiness is imported from
the session's bbm-infrastructure clone; no clone means NOT CHECKED, so the publish is refused.

Pure: reads stdin, writes stdout, no network, no writes. Self-test: python3 catalog_publish.py --selftest
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any, Optional

PRODUCTS = "65fa33419d90d967c68a0963"
BRANDS = "65fa33419d90d967c68a0965"
CATALOG = {PRODUCTS: "Products", BRANDS: "Brands"}
READ_MAX_AGE_MS = 60 * 60 * 1000          # a staged read older than this may not be what goes live
PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000    # the operator's rule: price verified under 24 h ago
CLOCK_SKEW_MS = 5 * 60 * 1000             # a verified-at in the future beyond this is wrong data
MAX_ITEMS = 100                           # Webflow's own per-call publish limit
READINESS_REL = os.path.join("webflow", "bulk-operations", "_shared")
DISCOUNT_RULE_REL = os.path.join("webflow", "bulk-operations", "article-audit")

PASS, BLOCK, NOT_CHECKED = "PASS", "BLOCK", "NOT CHECKED"


def _receipt(coll: str, item: str, verdict: str, reason: str) -> dict:
    return {"collection": CATALOG.get(coll, coll), "id": item, "verdict": verdict, "reason": reason}


def _blank(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return v.strip() == ""
    if isinstance(v, (list, dict, tuple)):
        return len(v) == 0
    return False


def _has_image(v: Any) -> bool:
    if isinstance(v, dict):
        return not _blank(v.get("url"))
    return isinstance(v, str) and not _blank(v)


def _same(a: Any, b: Any) -> bool:
    return isinstance(a, str) and isinstance(b, str) and a.strip().casefold() == b.strip().casefold()


def _parse_ts(v: Any) -> Optional[float]:
    """Postgres timestamptz text (`2026-11-20 08:35:00.091825+00`) or ISO 8601 -> ms epoch."""
    if not isinstance(v, str) or not v.strip():
        return None
    # Python 3.11+ fromisoformat reads `Z`, `+00` and a space separator itself (the selftest pins all three).
    try:
        dt = datetime.fromisoformat(v.strip())
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None                        # a naive time cannot be compared honestly
    return dt.astimezone(timezone.utc).timestamp() * 1000


def find_readiness(roots: list[str]):
    """product_readiness from the first clone that has it, or (None, why)."""
    for root in roots:
        d = os.path.join(root, READINESS_REL)
        if os.path.isfile(os.path.join(d, "product_readiness.py")):
            if d not in sys.path:
                sys.path.insert(0, d)
            try:
                return importlib.import_module("product_readiness"), ""
            except Exception as e:  # noqa: BLE001 - any import failure becomes a NOT CHECKED receipt  ratchet-ok: LC-2297 recorded as NOT CHECKED, never a pass
                return None, f"product_readiness.py could not be imported from {d} ({type(e).__name__}: {e})"
    return None, ("no bbm-infrastructure clone with webflow/bulk-operations/_shared/product_readiness.py "
                  "was found (looked in: " + ", ".join(roots) + ")")


def find_discount_rule(roots: list[str]):
    """brand_discount_rule (LC-2129) from the first clone that has it, or (None, why).

    Imported, never copied: the article audit and this publish check must judge a discount the
    same way. A private copy here is how a code-free sale passed the audit yet stayed blocked at
    publish for six days (LC-2370)."""
    for root in roots:
        d = os.path.join(root, DISCOUNT_RULE_REL)
        if os.path.isfile(os.path.join(d, "brand_discount_rule.py")):
            if d not in sys.path:
                sys.path.insert(0, d)
            try:
                return importlib.import_module("brand_discount_rule"), ""
            except Exception as e:  # noqa: BLE001 - any import failure becomes a NOT CHECKED receipt  ratchet-ok: LC-2370 recorded as NOT CHECKED, never a pass
                return None, f"brand_discount_rule.py could not be imported from {d} ({type(e).__name__}: {e})"
    return None, ("no bbm-infrastructure clone with webflow/bulk-operations/article-audit/brand_discount_rule.py "
                  "was found (looked in: " + ", ".join(roots) + ")")


def default_roots() -> list[str]:
    out: list[str] = []
    for r in (os.environ.get("CLAUDE_PROJECT_DIR", ""), os.getcwd()):
        while r and r not in out:
            out.append(r)
            parent = os.path.dirname(r)
            r = parent if parent != r else ""
    extra = ["/home/claude/bbm-infrastructure", os.path.expanduser("~/bbm-infrastructure")]
    # LCH-847: a CI job checks the repo out UNDER $GITHUB_WORKSPACE (the mutation shard uses caller/) and runs a
    # scratch copy elsewhere, so none of the paths above is the clone; the workspace and its children are.
    ws = os.environ.get("GITHUB_WORKSPACE", "")
    if os.path.isdir(ws):                  # isdir("") is False: unset means no CI roots
        extra += [ws] + sorted(os.path.join(ws, c) for c in os.listdir(ws) if os.path.isdir(os.path.join(ws, c)))
    for r in extra:
        if r not in out:
            out.append(r)
    return out


def brand_gaps(fd: dict, dr=None) -> list[str]:
    """Field gaps a Brands publish can break. `dr` is brand_discount_rule; the caller loads it
    only when discount-available is on, and refuses as NOT CHECKED when it cannot."""
    gaps: list[str] = []
    name = fd.get("name")
    for f in ("name", "brand-url"):
        if _blank(fd.get(f)):
            gaps.append(f"{f} is empty")
    if not _has_image(fd.get("full-size-image")):
        gaps.append("full-size-image is empty")
    alt = fd.get("full-size-image-alt-text")
    if _blank(alt):
        gaps.append("full-size-image-alt-text is empty")
    elif _same(alt, name):
        gaps.append("full-size-image-alt-text is the bare brand name")
    if _has_image(fd.get("brand-logo")):
        logo_alt = fd.get("brand-logo-alt-text")
        if _blank(logo_alt):
            gaps.append("brand-logo is set but brand-logo-alt-text is empty")
        elif _same(logo_alt, name):
            gaps.append("brand-logo-alt-text is the bare brand name")
    if fd.get("discount-available") is True:
        # LC-2129 rule, shared with the article audit: the message is always required; the code
        # (`discount`) only when the message tells the reader to use one. A code-free sitewide sale
        # must never be "fixed" by typing a made-up code into `discount` (LC-2370).
        for _rule, slug, problem, _fix in dr.findings(fd.get("discount-message"), fd.get("discount"), _blank):
            gaps.append(f"{slug}: {problem}")
    return gaps


def dead_link_proven(rec: Any, now_ms: float) -> bool:
    """LCH-370: the session's canonical dead-link read (DEAD_LINK_SQL_HEAD in register.ts) shows, within
    60 minutes, no redirect_slug, no affiliate_url, a brand partnership_status of inactive and
    is_affiliated false. Judged here from the raw row, not from any flag register.ts computed."""
    if not isinstance(rec, dict) or not isinstance(rec.get("row"), dict):
        return False
    at = rec.get("readAt")
    if not isinstance(at, (int, float)) or abs(now_ms - at) > READ_MAX_AGE_MS:
        return False
    r = rec["row"]
    return ("redirect_slug" in r and _blank(r.get("redirect_slug")) and "affiliate_url" in r
            and _blank(r.get("affiliate_url")) and r.get("partnership_status") == "inactive"
            and r.get("is_affiliated") is False)


def product_verdict(pr, fd: dict, row: Optional[dict], now_ms: float, dead: Any = None) -> tuple[str, str]:
    if not isinstance(row, dict):
        return NOT_CHECKED, ("no canonical Supabase context read for this item in this session "
                             "(run the context query the deny message gives)")
    product = {k: row.get(k) for k in ("review_id", "lc_reviewed", "product_line_id", "public_code")}
    line = ({"webflow_id": row.get("line_webflow_id"), "review_id": row.get("line_review_id")}
            if row.get("line_id") else None)
    card = {"card_sale_price": row.get("card_sale_price")} if row.get("card_row_found") is True else None
    ctx = pr.context_from_rows(product, line, card)
    gaps = pr.product_gaps(fd, ctx)
    # LCH-370 (operator decision 2026-11-25): a proven-dead product goes out with its link cleared. Only the
    # "product-link is empty" gap is dropped (a raw URL stays a gap), and the 24 h price rule is waived because
    # a product that no longer exists cannot have its price re-verified. Every other gap still blocks.
    if _blank(fd.get("product-link")) and dead_link_proven(dead, now_ms):
        rest = [g for g in gaps if not (g.field == "product-link" and g.code == "missing")]
        if rest:
            return BLOCK, "product_readiness gaps: " + pr.describe(rest)
        return PASS, ("dead product (LCH-370): link cleared, no redirect_slug or affiliate_url, brand inactive; "
                      "product_readiness otherwise clean; price check waived")
    if gaps:
        return BLOCK, "product_readiness gaps: " + pr.describe(gaps)
    at = _parse_ts(row.get("price_verified_at"))
    if at is None:
        return BLOCK, f"products.price_verified_at is missing or unreadable ({row.get('price_verified_at')!r})"
    age = now_ms - at
    if age < -CLOCK_SKEW_MS:
        return BLOCK, f"products.price_verified_at is in the future ({row.get('price_verified_at')})"
    if age > PRICE_MAX_AGE_MS:
        return BLOCK, (f"price verified {age / 3_600_000:.1f} h ago, over the 24 h limit "
                       "(request a refresh through the Catalog & Prices price queue)")
    return PASS, f"product_readiness: no gaps; price verified {max(age, 0) / 3_600_000:.1f} h ago"


def decide(payload: dict, roots: Optional[list[str]] = None) -> dict:
    now_ms = payload.get("now_ms")
    items = payload.get("items")
    seen = payload.get("seen") or {}
    ctx = payload.get("ctx") or {}
    dead = payload.get("dead") or {}
    receipts: list[dict] = []
    if not isinstance(now_ms, (int, float)) or not isinstance(items, list) or not items:
        return {"allow": False, "receipts": [_receipt("", "*", NOT_CHECKED, "the check got no items or no clock")]}
    if len(items) > MAX_ITEMS:
        return {"allow": False, "receipts": [_receipt("", "*", BLOCK, f"{len(items)} items in one call; at most {MAX_ITEMS}")]}
    pr = None
    pr_why = ""
    if any(isinstance(i, dict) and i.get("collection") == PRODUCTS for i in items):
        pr, pr_why = find_readiness(roots if roots is not None else default_roots())
    for it in items:
        coll = it.get("collection") if isinstance(it, dict) else None
        iid = it.get("id") if isinstance(it, dict) else None
        if coll not in CATALOG or not isinstance(iid, str) or not iid:
            receipts.append(_receipt(str(coll), str(iid), BLOCK, "not a Products or Brands item id"))
            continue
        rec = seen.get(iid)
        if not isinstance(rec, dict) or not isinstance(rec.get("fieldData"), dict):
            receipts.append(_receipt(coll, iid, NOT_CHECKED, "this session has not read the item's staged fields "
                                     "since its last Webflow write (read it with list_collection_items)"))
            continue
        if rec.get("collection") != coll:
            receipts.append(_receipt(coll, iid, BLOCK, f"the item was read from collection {rec.get('collection')}, "
                                     f"not {CATALOG[coll]}"))
            continue
        read_at = rec.get("readAt")
        if not isinstance(read_at, (int, float)) or now_ms - read_at > READ_MAX_AGE_MS:
            receipts.append(_receipt(coll, iid, NOT_CHECKED, "the staged read is over 60 minutes old; read the item again"))
            continue
        if rec.get("isArchived") is True:
            receipts.append(_receipt(coll, iid, BLOCK, "the item is archived"))
            continue
        fd = rec["fieldData"]
        if coll == BRANDS:
            dr = None
            if fd.get("discount-available") is True:
                dr, dr_why = find_discount_rule(roots if roots is not None else default_roots())
                if dr is None:
                    receipts.append(_receipt(coll, iid, NOT_CHECKED, dr_why))
                    continue
            g = brand_gaps(fd, dr)
            receipts.append(_receipt(coll, iid, BLOCK, "; ".join(g)) if g
                            else _receipt(coll, iid, PASS, "required fields present; alt text is not the bare name"))
            continue
        if pr is None:
            receipts.append(_receipt(coll, iid, NOT_CHECKED, pr_why))
            continue
        c = ctx.get(iid)
        row = c.get("row") if isinstance(c, dict) else None
        c_at = c.get("readAt") if isinstance(c, dict) else None
        if isinstance(row, dict) and (not isinstance(c_at, (int, float)) or now_ms - c_at > READ_MAX_AGE_MS):
            receipts.append(_receipt(coll, iid, NOT_CHECKED, "the Supabase context read is over 60 minutes old; run it again"))
            continue
        try:
            verdict, why = product_verdict(pr, fd, row, now_ms, dead.get(iid) if isinstance(dead, dict) else None)
        except Exception as e:  # noqa: BLE001 - a readiness crash becomes a NOT CHECKED receipt naming the error
            verdict, why = NOT_CHECKED, f"product_readiness raised {type(e).__name__}: {e}"
        receipts.append(_receipt(coll, iid, verdict, why))
    return {"allow": bool(receipts) and all(r["verdict"] == PASS for r in receipts), "receipts": receipts}


# ---------------------------------------------------------------- selftest
def _selftest() -> int:  # noqa: C901 — a flat list of small assertions
    checks = fails = 0

    def ck(cond: bool, msg: str) -> None:
        nonlocal checks, fails
        checks += 1
        if not cond:
            fails += 1
            print(f"  FAIL: {msg}", file=sys.stderr)

    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", "..", ".."))
    # The repo beside this file, then the usual places: a mutation sweep runs a scratch copy elsewhere.
    roots = [repo] + [r for r in default_roots() if r != repo]
    NOW = 1_800_000_000_000
    iso = lambda ms: datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f+00")  # noqa: E731 - a one-line test fixture builder

    def product_fd() -> dict:
        return {"name": "Albany Sofa", "feature-image": {"url": "https://x/a.webp"},
                "alt-text-for-feature-image": "Albany sofa in oat linen, side view",
                "category-2": "c2", "product-category": "pc", "brand": "b1",
                "product-link": "https://go.livingcozy.com/albany-sofa", "price": "$1,999",
                "price-in-button": "$1,999", "display-brand": "Albany Park", "review": False,
                "prid": "P-12345", "product-status": "", "product-family": None}

    pr, why = find_readiness(roots)
    ck(pr is not None, f"product_readiness imports from the repo ({why})")
    with tempfile.TemporaryDirectory() as ws:  # LCH-847: a CI checkout under $GITHUB_WORKSPACE (the shard's caller/)
        os.mkdir(os.path.join(ws, "caller"))
        old_ws = os.environ.get("GITHUB_WORKSPACE")
        os.environ["GITHUB_WORKSPACE"] = ws
        try:
            got = default_roots()
        finally:
            if old_ws is None:
                os.environ.pop("GITHUB_WORKSPACE", None)
            else:
                os.environ["GITHUB_WORKSPACE"] = old_ws
        ck(ws in got and os.path.join(ws, "caller") in got, f"a CI workspace and its checkout are roots ({got})")
        ck(os.path.join(ws, "caller") not in default_roots(), "a workspace no longer named is not a root")
    if pr is not None:
        # product-status must be a real Option id; take one from the module itself.
        status = sorted(pr.PRODUCT_STATUS_OPTION_IDS)[0]

    def prow(**over) -> dict:
        r = {"webflow_id": "p1", "public_code": "P-12345", "review_id": None, "lc_reviewed": False,
             "product_line_id": None, "price_verified_at": iso(NOW - 3_600_000), "line_id": None,
             "line_webflow_id": None, "line_review_id": None, "card_row_found": True, "card_sale_price": None}
        r.update(over)
        return r

    def run(items, seen, ctx=None, roots_=roots, now=NOW, dead=None):
        return decide({"now_ms": now, "items": items, "seen": seen, "ctx": ctx or {}, "dead": dead or {}}, roots_)

    def pfd(**over):
        fd = product_fd()
        if pr is not None:
            fd["product-status"] = status
        fd.update(over)
        return fd

    P = {"collection": PRODUCTS, "id": "p1"}
    seenP = lambda fd, **o: {"p1": {"collection": PRODUCTS, "fieldData": fd, "readAt": NOW - 60_000, **o}}  # noqa: E731 - a one-line test fixture builder
    ctxP = lambda row, at=NOW - 60_000: {"p1": {"row": row, "readAt": at}}  # noqa: E731 - a one-line test fixture builder

    if pr is not None:
        r = run([P], seenP(pfd()), ctxP(prow()))
        ck(r["allow"] is True and r["receipts"][0]["verdict"] == PASS, f"a ready product with a fresh price passes: {r}")
        ck("no gaps" in r["receipts"][0]["reason"], "the PASS receipt says why")

        r = run([P], seenP(pfd()), ctxP(prow(price_verified_at=iso(NOW - PRICE_MAX_AGE_MS - 60_000))))
        ck(r["allow"] is False and "over the 24 h limit" in r["receipts"][0]["reason"], "a price verified 24h+ ago blocks")
        r = run([P], seenP(pfd()), ctxP(prow(price_verified_at=iso(NOW - PRICE_MAX_AGE_MS + 60_000))))
        ck(r["allow"] is True, "a price verified just under 24h ago passes (boundary)")
        r = run([P], seenP(pfd()), ctxP(prow(price_verified_at=None)))
        ck(r["allow"] is False and "missing or unreadable" in r["receipts"][0]["reason"], "no price_verified_at blocks")
        r = run([P], seenP(pfd()), ctxP(prow(price_verified_at="2026-11-20 08:35:00")))
        ck(r["allow"] is False, "a naive timestamp is unreadable, never guessed")
        r = run([P], seenP(pfd()), ctxP(prow(price_verified_at=iso(NOW + CLOCK_SKEW_MS + 60_000))))
        ck(r["allow"] is False and "future" in r["receipts"][0]["reason"], "a verified-at in the future blocks")

        r = run([P], seenP(pfd(**{"alt-text-for-feature-image": "Albany Sofa"})), ctxP(prow()))
        ck(r["allow"] is False and "alt-text-for-feature-image" in r["receipts"][0]["reason"], "alt = name blocks (product_readiness)")
        r = run([P], seenP(pfd(**{"product-link": "https://brand.com/x"})), ctxP(prow()))
        ck(r["allow"] is False and "product-link" in r["receipts"][0]["reason"], "a non go-link blocks")
        r = run([P], seenP(pfd(prid="P-99999")), ctxP(prow()))
        ck(r["allow"] is False and "prid" in r["receipts"][0]["reason"], "prid must equal public_code")
        r = run([P], seenP(pfd()), ctxP(prow(review_id="rev-1")))
        ck(r["allow"] is False and "review" in r["receipts"][0]["reason"], "a reviewed product with review off blocks (context used)")
        r = run([P], seenP(pfd()), ctxP(prow(card_sale_price="1500.00")))
        ck(r["allow"] is False and "sale-price" in r["receipts"][0]["reason"], "a claimed sale with no sale-price blocks (card row used)")
        r = run([P], seenP(pfd()), ctxP(prow(card_row_found=False)))
        ck(r["allow"] is False, "no card row = sale unknown = context gap, never a pass")
        r = run([P], seenP(pfd()), ctxP(prow(product_line_id="l1", line_id=None)))
        ck(r["allow"] is False, "a line that could not be read is unknown, never 'no family'")

        # LCH-370: a proven-dead product passes with its link cleared; the price rule is waived for it only.
        drow = lambda **o: {"webflow_id": "p1", "redirect_slug": None, "affiliate_url": None,  # noqa: E731 - fixture
                            "partnership_status": "inactive", "is_affiliated": False, **o}
        deadP = lambda row, at=NOW - 60_000: {"p1": {"row": row, "readAt": at}}  # noqa: E731 - fixture
        stale_price = ctxP(prow(price_verified_at=None))
        r = run([P], seenP(pfd(**{"product-link": None})), stale_price, dead=deadP(drow()))
        ck(r["allow"] is True and "LCH-370" in r["receipts"][0]["reason"], f"a proven-dead product with a cleared link passes: {r}")
        r = run([P], seenP(pfd(**{"product-link": ""})), stale_price, dead=deadP(drow()))
        ck(r["allow"] is True, "an empty-string link counts as cleared")
        r = run([P], seenP(pfd(**{"product-link": None})), stale_price)
        ck(r["allow"] is False and "product-link" in r["receipts"][0]["reason"], "a cleared link with no dead-link read blocks")
        for bad, msg in ((drow(redirect_slug="tile-mat"), "a redirect_slug"), (drow(affiliate_url="https://a.x/y"), "an affiliate_url"),
                         (drow(partnership_status="active"), "an active brand"), (drow(is_affiliated=True), "an affiliated brand"),
                         (drow(is_affiliated=None), "an unknown is_affiliated"), ({"webflow_id": "p1", "partnership_status": "inactive",
                          "is_affiliated": False}, "a row missing the link columns")):
            r = run([P], seenP(pfd(**{"product-link": None})), stale_price, dead=deadP(bad))
            ck(r["allow"] is False, f"{msg} means not dead: blocks")
        r = run([P], seenP(pfd(**{"product-link": None})), stale_price, dead=deadP(drow(), at=NOW - READ_MAX_AGE_MS - 1))
        ck(r["allow"] is False, "a dead-link read over 60 minutes old blocks")
        r = run([P], seenP(pfd(**{"product-link": "https://letterfolk.com/x"})), stale_price, dead=deadP(drow()))
        ck(r["allow"] is False and "product-link" in r["receipts"][0]["reason"], "a raw URL on a dead product still blocks")
        r = run([P], seenP(pfd(**{"product-link": None, "alt-text-for-feature-image": "Albany Sofa"})), stale_price, dead=deadP(drow()))
        ck(r["allow"] is False and "alt-text" in r["receipts"][0]["reason"], "other gaps still block a dead product")
        r = run([P], seenP(pfd()), ctxP(prow(price_verified_at=None)), dead=deadP(drow()))
        ck(r["allow"] is False and "missing or unreadable" in r["receipts"][0]["reason"],
           "a dead product that still carries a go link keeps the price rule")

        r = run([P], seenP(pfd()), {})
        ck(r["allow"] is False and r["receipts"][0]["verdict"] == NOT_CHECKED, "no context read is NOT CHECKED")
        r = run([P], seenP(pfd()), ctxP(prow(), at=NOW - READ_MAX_AGE_MS - 1))
        ck(r["allow"] is False and r["receipts"][0]["verdict"] == NOT_CHECKED, "a stale context read is NOT CHECKED")

    r = run([P], {}, ctxP(prow()))
    ck(r["allow"] is False and r["receipts"][0]["verdict"] == NOT_CHECKED, "no staged read is NOT CHECKED")
    r = run([P], {"p1": {"collection": PRODUCTS, "fieldData": pfd(), "readAt": NOW - READ_MAX_AGE_MS - 1}}, ctxP(prow()))
    ck(r["allow"] is False and "60 minutes" in r["receipts"][0]["reason"], "a stale staged read is NOT CHECKED")
    r = run([P], {"p1": {"collection": BRANDS, "fieldData": pfd(), "readAt": NOW}}, ctxP(prow()))
    ck(r["allow"] is False and r["receipts"][0]["verdict"] == BLOCK, "an item read from the other collection blocks")
    r = run([P], seenP(pfd(), isArchived=True), ctxP(prow()))
    ck(r["allow"] is False and "archived" in r["receipts"][0]["reason"], "an archived item blocks")
    r = run([P], seenP(pfd()), ctxP(prow()), roots_=["/nonexistent-root"])
    ck(r["allow"] is False and r["receipts"][0]["verdict"] == NOT_CHECKED and "clone" in r["receipts"][0]["reason"],
       "no clone with product_readiness is NOT CHECKED")

    # Brands.
    B = {"collection": BRANDS, "id": "b1"}

    def bfd(**over):
        fd = {"name": "Sabai", "brand-url": "https://sabai.design", "full-size-image": {"url": "https://x/s.webp"},
              "full-size-image-alt-text": "Sabai sofa in a sunlit living room"}
        fd.update(over)
        return fd

    seenB = lambda fd: {"b1": {"collection": BRANDS, "fieldData": fd, "readAt": NOW - 60_000}}  # noqa: E731 - a one-line test fixture builder
    r = run([B], seenB(bfd()), roots_=["/nonexistent-root"])
    ck(r["allow"] is True and r["receipts"][0]["verdict"] == PASS, f"a complete brand passes, with no clone needed: {r}")
    r = run([B], seenB(bfd(**{"full-size-image-alt-text": "  sabai "})))
    ck(r["allow"] is False and "bare brand name" in r["receipts"][0]["reason"], "brand alt = name (any case) blocks")
    for f in ("name", "brand-url", "full-size-image-alt-text"):
        r = run([B], seenB(bfd(**{f: ""})))
        ck(r["allow"] is False and f in r["receipts"][0]["reason"], f"empty {f} blocks")
    r = run([B], seenB(bfd(**{"full-size-image": {"url": ""}})))
    ck(r["allow"] is False and "full-size-image is empty" in r["receipts"][0]["reason"], "an image with no url blocks")
    r = run([B], seenB(bfd(**{"brand-logo": {"url": "https://x/l.svg"}})))
    ck(r["allow"] is False and "brand-logo-alt-text" in r["receipts"][0]["reason"], "a logo with no alt blocks")
    r = run([B], seenB(bfd(**{"brand-logo": {"url": "https://x/l.svg"}, "brand-logo-alt-text": "Sabai"})))
    ck(r["allow"] is False and "brand-logo-alt-text is the bare" in r["receipts"][0]["reason"], "logo alt = name blocks")
    r = run([B], seenB(bfd(**{"brand-logo": {"url": "https://x/l.svg"}, "brand-logo-alt-text": "Sabai wordmark"})))
    ck(r["allow"] is True, "a logo with real alt text passes")
    r = run([B], seenB(bfd(**{"discount-available": True, "discount": "SAVE10"})))
    ck(r["allow"] is False and "discount-message" in r["receipts"][0]["reason"], "a discount with no message blocks")
    r = run([B], seenB(bfd(**{"discount-available": True, "discount": "SAVE10", "discount-message": "10% off"})))
    ck(r["allow"] is True, "a complete discount passes")
    # LC-2370: the LC-2129 rule, both sides. A code-free sale (the 7 BFCM brands) must pass with
    # `discount` empty; a message that names a code with `discount` empty must still block.
    for empty in ("", None, "  "):
        r = run([B], seenB(bfd(**{"discount-available": True, "discount": empty,
                                  "discount-message": "Up to 40% off select items, through Nov 30"})))
        ck(r["allow"] is True and r["receipts"][0]["verdict"] == PASS, f"a code-free sale passes with discount={empty!r}: {r}")
    for msg in ("10% off sofas with code COZY10", "Use promo code at checkout"):
        r = run([B], seenB(bfd(**{"discount-available": True, "discount": "", "discount-message": msg})))
        ck(r["allow"] is False and r["receipts"][0]["verdict"] == BLOCK
           and "discount: the discount message tells the reader to use a code" in r["receipts"][0]["reason"],
           f"a message naming a code with the code empty blocks: {msg!r} -> {r}")
    r = run([B], seenB(bfd(**{"discount-available": True, "discount": "", "discount-message": ""})))
    ck(r["allow"] is False and r["receipts"][0]["reason"].count("discount-message") == 1
       and "discount:" not in r["receipts"][0]["reason"], "no message and no code reports the message once, not the code")
    r = run([B], seenB(bfd(**{"discount-available": False, "discount": "", "discount-message": ""})))
    ck(r["allow"] is True, "discount-available off ignores both discount fields")
    r = run([B], seenB(bfd(**{"discount-available": "true", "discount": "", "discount-message": ""})))
    ck(r["allow"] is True, "only a real True turns the discount check on (Webflow switches are booleans)")
    # The rule lives in the clone: no clone -> NOT CHECKED when a discount is on, never a pass.
    r = run([B], seenB(bfd(**{"discount-available": True, "discount-message": "Up to 40% off"})), roots_=["/nonexistent-root"])
    ck(r["allow"] is False and r["receipts"][0]["verdict"] == NOT_CHECKED and "brand_discount_rule" in r["receipts"][0]["reason"],
       f"discount on with no clone is NOT CHECKED: {r}")
    dr, why = find_discount_rule(["/nonexistent-root"] + roots)
    ck(dr is not None and why == "" and hasattr(dr, "findings"), f"the rule is found past a root without it ({why})")

    # One bad item spoils the batch; the good one still gets its own PASS receipt.
    r = run([B, {"collection": BRANDS, "id": "b2"}], {**seenB(bfd()), "b2": {"collection": BRANDS, "fieldData": bfd(name=""), "readAt": NOW}})
    ck(r["allow"] is False and [x["verdict"] for x in r["receipts"]] == [PASS, BLOCK], "one bad item refuses the batch, receipts per item")

    # Value helpers, pinned case by case (each was a surviving mutant once).
    ck(_blank([]) and _blank({}) and _blank("  ") and _blank(None), "empty containers, blank strings and None are blank")
    ck(not _blank(0) and not _blank(False) and not _blank([0]), "a number, a bool and a non-empty list are values")
    ck(_has_image("https://x/a.webp") and not _has_image("  ") and not _has_image({"url": None}) and not _has_image(None),
       "an image is a non-blank url string or a dict with a non-blank url")
    ck(not _has_image({"fileId": "f"}), "an image dict with no url is not an image")
    t = _parse_ts("2026-11-20 08:35:00.091825+00")
    ck(t is not None and t == _parse_ts("2026-11-20T08:35:00.091825Z") == _parse_ts("2026-11-20T08:35:00.091825+00:00"),
       "Postgres +00, ISO Z and +00:00 read as the same instant")
    ck(_parse_ts("2026-11-20 08:35:00") is None, "a naive timestamp is unreadable, never assumed UTC")
    ck(_parse_ts("yesterday") is None and _parse_ts(7) is None and _parse_ts(" ") is None, "junk timestamps are unreadable")
    old_env = os.environ.get("CLAUDE_PROJECT_DIR")
    os.environ["CLAUDE_PROJECT_DIR"] = "/a/b"
    try:
        dr = default_roots()
    finally:
        if old_env is None:
            os.environ.pop("CLAUDE_PROJECT_DIR", None)
        else:
            os.environ["CLAUDE_PROJECT_DIR"] = old_env
    ck(dr[:3] == ["/a/b", "/a", "/"] and len(dr) == len(set(dr)) and "/home/claude/bbm-infrastructure" in dr,
       f"default_roots walks the project dir up to /, then the usual clone, without repeats: {dr}")

    if pr is not None:
        r = run([P], seenP(pfd()), {"p1": {"row": None, "readAt": NOW}})
        ck(r["receipts"][0]["verdict"] == NOT_CHECKED and "no canonical Supabase context" in r["receipts"][0]["reason"],
           "a context entry with no row says so, not a crash")
        naive = datetime.fromtimestamp((NOW - 3_600_000) / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        r = run([P], seenP(pfd()), ctxP(prow(price_verified_at=naive)))
        ck(r["allow"] is False and "unreadable" in r["receipts"][0]["reason"], "a fresh but naive verified-at blocks as unreadable")

    r = run([{"collection": "65fa33419d90d967c68a0964", "id": "p1"}], seenP(pfd()), ctxP(prow()))
    ck(r["receipts"][0]["verdict"] == BLOCK and "not a Products or Brands item id" in r["receipts"][0]["reason"],
       "a Blog Posts item is refused by name, before any evidence is read")
    r = run([{"collection": BRANDS, "id": ""}], {"": {"collection": BRANDS, "fieldData": bfd(), "readAt": NOW}})
    ck(r["receipts"][0]["verdict"] == BLOCK, "an empty item id is refused even when a record matches it")
    ck(main(["--bogus"]) == 1, "an unknown argument is refused")

    # Malformed input never allows.
    for bad in ({}, {"now_ms": NOW}, {"now_ms": NOW, "items": []}, {"now_ms": "x", "items": [B]},
                {"now_ms": NOW, "items": [{"collection": "65fa33419d90d967c68a0964", "id": "x"}]},
                {"now_ms": NOW, "items": [None]}, {"now_ms": NOW, "items": [{"collection": BRANDS, "id": ""}]}):
        ck(decide(bad, roots)["allow"] is False, f"malformed or non-catalog input never allows: {bad}")
    ck(decide({"now_ms": NOW, "items": [B] * (MAX_ITEMS + 1), "seen": seenB(bfd())}, roots)["allow"] is False,
       "more than 100 items in one call is refused")

    # Driven over stdin the way register.ts runs it.
    import subprocess
    p = subprocess.run([sys.executable, "-I", os.path.abspath(__file__)], capture_output=True, text=True, timeout=60,
                       input=json.dumps({"now_ms": NOW, "items": [B], "seen": seenB(bfd())}))
    out = json.loads(p.stdout or "{}")
    ck(p.returncode == 0 and out.get("allow") is True, f"stdin -> stdout round trip ({p.stderr.strip()[:200]})")
    p = subprocess.run([sys.executable, "-I", os.path.abspath(__file__)], capture_output=True, text=True, timeout=60, input="{not json")
    ck(p.returncode == 1 and p.stdout == "", "unreadable input exits 1 with no verdict (register.ts denies)")
    p = subprocess.run([sys.executable, "-I", os.path.abspath(__file__)], capture_output=True, text=True, timeout=60, input="[1]")
    ck(p.returncode == 1 and p.stdout == "", "a JSON payload that is not an object exits 1 with no verdict")

    print(f"catalog_publish selftest: {checks - fails}/{checks} checks passed")
    return 1 if fails else 0


def main(argv: list[str]) -> int:
    if argv == ["--selftest"]:
        return _selftest()
    if argv:
        sys.stderr.write(f"catalog_publish: unexpected arguments {argv!r}\n")
        return 1
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        # Mutation note: with this guard off, decide() raises on `[1]` and the exit is still 1 with no
        # stdout, so its surviving mutant is equivalent; the guard stays for the plain error message.
        if not isinstance(payload, dict):
            raise ValueError("payload is not an object")
    except ValueError as e:
        sys.stderr.write(f"catalog_publish: unreadable input ({e})\n")
        return 1
    json.dump(decide(payload), sys.stdout)
    sys.stdout.write("\n")
    return 0


# Mutation note: switching this guard off makes `--selftest` print nothing and exit 0, which mutate.py
# scores as a survivor; claude-mods.yml reads the count line, so that mutant cannot pass CI.
if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
