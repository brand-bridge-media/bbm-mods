#!/usr/bin/env python3
"""mod-freshness: is the mod code this session loaded still what the bbm-mods mirror ships?

Why (LC-1711 follow-up, 2026-10-22): mods are installed once, when a cloud container starts.
A session kept open across mod merges keeps running the old code. That day the Catalog
orchestrator ran a fleet-tracker from before PR #1979: no auto-track on create_session, and the
old wake text that said to send a phone push. A fresh container had the fixed mod. Nothing told
the old session, so it read as "Claude ignores the mods".

One job: compare each loaded bbm mod with the mirror's current copy of it, file by file.

Payload on stdin (JSON):
  {"mode": "snapshot", "plugin_dirs": "<CLAUDE_CODE_PLUGIN_DIRS>"}
      -> {"loaded": {"<mod>": "<digest>"}, "account": bool, "synced_at": "<ISO>"|None}
         fingerprint of what was loaded, at session start
  {"mode": "check", "loaded": {...}, "account": bool, "synced_at": "<ISO>"|None}
      -> {"stale": [...], "fresh": [...], "missing": [...], "account": bool,
          "not_checked": {"<mod>": "<reason>"}, "mirror": "<subject>", "mirror_at": "<ISO>",
          "account_behind": bool}

"account" (LC-2217, 2026-11-18): project threads get no CLAUDE_CODE_PLUGIN_DIRS. They load the
claude.ai ACCOUNT copy of the mods from ~/.claude/plugins/synced/<org>_<id>/<mod>/, and that copy
does not follow the mirror (it sat 19 hours and 13 mods behind). A fresh session does not fix it;
only the operator refreshing or re-uploading on claude.ai does. So when any mod came from the
account copy, the check also lists mirror mods the session never loaded ("missing").

"account_behind" (LC-2217 follow-up, 2026-11-20, board request #72): a thread keeps the account
copy it synced when its container started. Three Refresh Engine threads that started before the
operator's Check for updates kept asking for it after it was done. So the check now says whether
the ACCOUNT copy is behind (the thread synced after the mirror's head commit and still differs:
certain), or only THIS thread's copy (it synced before that commit: a new thread may already be
current, so the operator is not asked).

Optional payload keys for tests: home, cache_dir, mirror_url.
Fails open: any error is a NOT CHECKED line, never a "fresh".
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile

MARKETPLACE = 'bbm-mods'
DEFAULT_URL = 'https://github.com/brand-bridge-media/bbm-mods.git'
# .in_use: the marker directory the account sync drops into each plugin it loads (LC-2217).
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.in_use'}
GIT_TIMEOUT = 45


def digest_files(files: dict[str, bytes]) -> str:
    """One fingerprint for a mod: every file's relative path and bytes, in path order."""
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode() + b'\0' + files[rel] + b'\0')
    return h.hexdigest()


def read_dir(root: str) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for d, subdirs, names in os.walk(root):
        subdirs[:] = [s for s in subdirs if s not in SKIP_DIRS]
        for n in names:
            p = os.path.join(d, n)
            if os.path.islink(p) or not os.path.isfile(p):
                continue
            with open(p, 'rb') as f:
                files[os.path.relpath(p, root).replace(os.sep, '/')] = f.read()
    return files


def plugin_name(d: str) -> str | None:
    try:
        with open(os.path.join(d, '.claude-plugin', 'plugin.json'), encoding='utf-8') as f:
            name = json.load(f).get('name')
        return name if isinstance(name, str) and name else None
    except (OSError, ValueError, AttributeError):
        return None


def synced_dirs(home: str) -> dict[str, str]:
    """mod name -> directory, for the claude.ai account copy a project thread syncs at start.

    Every synced plugin is listed (marketplace and hand-uploaded alike); check() ignores the
    names the mirror does not ship, so Anthropic's own plugins never count.
    """
    out: dict[str, str] = {}
    root = os.path.join(home, '.claude', 'plugins', 'synced')
    try:
        for org in sorted(os.listdir(root)):
            base = os.path.join(root, org)
            for entry in sorted(os.listdir(base)) if os.path.isdir(base) else []:
                d = os.path.join(base, entry)
                name = plugin_name(d) if os.path.isdir(d) else None
                if name:
                    out[name] = d
    except OSError:
        pass
    return out


def loaded_dirs(home: str, plugin_dirs: str) -> dict[str, str]:
    """mod name -> the directory its code was loaded from.

    Account copy (project threads) first, then installed @bbm-mods plugins; a
    CLAUDE_CODE_PLUGIN_DIRS entry (bbm-infrastructure sessions load the checkout copy) replaces
    an earlier one of the same name, as it shadows it at load time.
    """
    out: dict[str, str] = dict(synced_dirs(home))
    try:
        with open(os.path.join(home, '.claude', 'plugins', 'installed_plugins.json'), encoding='utf-8') as f:
            plugins = json.load(f).get('plugins', {})
        for key, entries in plugins.items():
            name, _, market = key.partition('@')
            if market == MARKETPLACE and entries and isinstance(entries[0], dict) and entries[0].get('installPath'):
                out[name] = entries[0]['installPath']
    except (OSError, ValueError, AttributeError):
        pass
    for d in (plugin_dirs or '').split(':'):
        name = plugin_name(d) if d else None
        if name:
            out[name] = d
    return out


def synced_at(home: str) -> str | None:
    """When this container synced the account copy: the newest manifest.json lastUpdated (epoch ms), as ISO UTC."""
    import datetime
    newest = None
    root = os.path.join(home, '.claude', 'plugins', 'synced')
    try:
        for org in os.listdir(root):
            try:
                with open(os.path.join(root, org, 'manifest.json'), encoding='utf-8') as f:
                    ms = json.load(f).get('lastUpdated')
            except (OSError, ValueError, AttributeError):
                continue
            if isinstance(ms, (int, float)) and not isinstance(ms, bool) and (newest is None or ms > newest):
                newest = ms
    except OSError:
        return None
    if newest is None:
        return None
    return datetime.datetime.fromtimestamp(newest / 1000, datetime.timezone.utc).isoformat()


def _when(iso: object):
    import datetime
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace('Z', '+00:00'))
        return t if t.tzinfo else None
    except ValueError:
        return None


def snapshot(home: str, plugin_dirs: str) -> dict:
    loaded = {}
    synced = os.path.join(home, '.claude', 'plugins', 'synced') + os.sep
    account = False
    for name, d in loaded_dirs(home, plugin_dirs).items():
        try:
            loaded[name] = digest_files(read_dir(d))
        except OSError:
            continue
        account = account or d.startswith(synced)
    return {'loaded': loaded, 'account': account, 'synced_at': synced_at(home) if account else None}


def mirror_url(home: str) -> str:
    """The URL the marketplace was added from (it follows the repo across renames)."""
    try:
        with open(os.path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), encoding='utf-8') as f:
            repo = json.load(f)[MARKETPLACE]['source']['repo']
        if isinstance(repo, str) and repo.count('/') == 1:
            return f'https://github.com/{repo}.git'
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return DEFAULT_URL


def git(cache: str, *args: str, binary: bool = False):
    r = subprocess.run(['git', '-C', cache, *args], capture_output=True, timeout=GIT_TIMEOUT)
    if r.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed: {r.stderr.decode(errors='replace').strip()[:200]}")
    return r.stdout if binary else r.stdout.decode(errors='replace')


def fetch_mirror(cache: str, url: str) -> None:
    """A private shallow copy of the mirror; never the plugin manager's own marketplace clone."""
    if not os.path.isdir(os.path.join(cache, '.git')):
        os.makedirs(cache, exist_ok=True)
        git(cache, 'init', '-q')
    git(cache, 'fetch', '-q', '--depth', '1', url, 'HEAD')


def mirror_mods(cache: str) -> dict[str, str]:
    """mod name -> digest of the mirror's copy at FETCH_HEAD."""
    manifest = json.loads(git(cache, 'show', 'FETCH_HEAD:.claude-plugin/marketplace.json'))
    sources = {p['name']: p['source'].removeprefix('./').rstrip('/') for p in manifest.get('plugins', [])
               if isinstance(p, dict) and isinstance(p.get('name'), str) and isinstance(p.get('source'), str)}
    files: dict[str, dict[str, bytes]] = {n: {} for n in sources}
    archive = git(cache, 'archive', '--format=tar', 'FETCH_HEAD', *sources.values(), binary=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for m in tar:
            if not m.isfile():
                continue
            for name, src in sources.items():
                if m.name.startswith(src + '/'):
                    rel = m.name[len(src) + 1:]
                    if not set(rel.split('/')) & SKIP_DIRS:
                        files[name][rel] = tar.extractfile(m).read()
    return {n: digest_files(f) for n, f in files.items()}


def check(loaded: dict, home: str, cache: str, url: str, account: bool = False, synced: object = None) -> dict:
    out: dict = {'stale': [], 'fresh': [], 'missing': [], 'account': bool(account), 'not_checked': {}, 'mirror': '',
                 'mirror_at': '', 'account_behind': bool(account)}
    if not isinstance(loaded, dict):
        out['not_checked']['*'] = f'malformed snapshot ({type(loaded).__name__}, expected an object)'
        return out
    if not loaded:
        out['not_checked']['*'] = 'no session-start snapshot of the loaded mods'
        return out
    try:
        fetch_mirror(cache, url)
        latest = mirror_mods(cache)
        out['mirror'] = git(cache, 'log', '-1', '--format=%s (%cI)', 'FETCH_HEAD').strip()
        out['mirror_at'] = git(cache, 'log', '-1', '--format=%cI', 'FETCH_HEAD').strip()
    except (RuntimeError, OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError) as exc:
        out['not_checked']['*'] = f'mirror unreadable: {exc}'
        return out
    for name in sorted(loaded):
        if name not in latest:
            continue  # not a bbm mod, or one the mirror has since dropped
        (out['fresh'] if loaded[name] == latest[name] else out['stale']).append(name)
    if account:
        out['missing'] = sorted(n for n in latest if n not in loaded)
        # Certain only when this thread synced AFTER the mirror's head commit. Unknown times stay
        # "behind" (the old, louder answer), never a silent "fine".
        s, m = _when(synced), _when(out['mirror_at'])
        out['account_behind'] = not (s and m and s < m)
    # Comparing nothing must never read like "all fresh".
    if not out['stale'] and not out['fresh']:
        out['not_checked']['*'] = 'no loaded mod is shipped by the mirror, so nothing was compared'
    return out


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        home = payload.get('home') or os.path.expanduser('~')
        if payload.get('mode') == 'snapshot':
            result = snapshot(home, payload.get('plugin_dirs') or os.environ.get('CLAUDE_CODE_PLUGIN_DIRS', ''))
        else:
            cache = payload.get('cache_dir') or os.path.join(home, '.cache', 'mod-freshness', 'mirror')
            result = check(payload.get('loaded') or {}, home, cache, payload.get('mirror_url') or mirror_url(home),
                           bool(payload.get('account')), payload.get('synced_at'))
    except Exception as exc:  # fail open, loudly
        result = {'stale': [], 'fresh': [], 'not_checked': {'*': f'check crashed: {exc}'}, 'mirror': ''}
    print(json.dumps(result))
    return 0


# --------------------------------------------------------------------------- selftest

def selftest() -> int:
    import shutil
    import tempfile

    passed = total = 0

    def ok(cond: bool, label: str) -> None:
        nonlocal passed, total
        total += 1
        passed += bool(cond)
        print(('PASS ' if cond else 'FAIL ') + label)

    tmp = tempfile.mkdtemp(prefix='mod-freshness-')
    try:
        env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't',
               'GIT_COMMITTER_EMAIL': 't@t', 'GIT_CONFIG_NOSYSTEM': '1', 'HOME': tmp}

        def sh(cwd: str, *a: str) -> None:
            subprocess.run(a, cwd=cwd, env=env, check=True, capture_output=True)

        def write(path: str, text: str) -> None:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(text)

        # A mirror with two mods.
        mirror = os.path.join(tmp, 'mirror')
        for mod in ('alpha', 'beta'):
            write(f'{mirror}/claude-mods/{mod}/.claude-plugin/plugin.json', json.dumps({'name': mod}))
            write(f'{mirror}/claude-mods/{mod}/hooks/register.ts', f'// {mod} v1\n')
        write(f'{mirror}/.claude-plugin/marketplace.json', json.dumps({'name': MARKETPLACE, 'plugins': [
            {'name': m, 'source': f'./claude-mods/{m}'} for m in ('alpha', 'beta')]}))
        sh(tmp, 'git', 'init', '-q', '-b', 'main', mirror)
        sh(mirror, 'git', 'add', '-A')
        sh(mirror, 'git', 'commit', '-qm', 'Sync from bbm-infrastructure@aaaa')
        url = 'file://' + mirror

        # A session that installed both, plus a checkout copy of beta in a plugin dir.
        home = os.path.join(tmp, 'home')
        installed = {}
        for mod in ('alpha', 'beta'):
            dst = f'{home}/.claude/plugins/cache/{MARKETPLACE}/{mod}/0.1.0'
            shutil.copytree(f'{mirror}/claude-mods/{mod}', dst)
            installed[f'{mod}@{MARKETPLACE}'] = [{'installPath': dst}]
        installed['other@elsewhere'] = [{'installPath': '/nonexistent'}]
        write(f'{home}/.claude/plugins/installed_plugins.json', json.dumps({'plugins': installed}))
        checkout_beta = os.path.join(tmp, 'checkout', 'beta')
        shutil.copytree(f'{mirror}/claude-mods/beta', checkout_beta)
        os.makedirs(f'{checkout_beta}/node_modules')
        write(f'{checkout_beta}/node_modules/junk.js', 'ignored')

        snap = snapshot(home, f'/nope:{checkout_beta}')['loaded']
        ok(sorted(snap) == ['alpha', 'beta'], 'snapshot covers only bbm mods and plugin dirs')
        ok(snap['beta'] == digest_files(read_dir(f'{mirror}/claude-mods/beta')), 'plugin dir wins; node_modules ignored')

        cache = os.path.join(tmp, 'cache')
        r = check(snap, home, cache, url)
        ok(r['stale'] == [] and r['fresh'] == ['alpha', 'beta'] and not r['not_checked'], 'unchanged mirror reads fresh')
        ok(r['mirror'].startswith('Sync from bbm-infrastructure@aaaa'), 'mirror commit subject reported')

        # Upstream changes alpha only: alpha is stale, beta stays fresh (per-mod, not per-commit).
        write(f'{mirror}/claude-mods/alpha/hooks/register.ts', '// alpha v2\n')
        sh(mirror, 'git', 'commit', '-qam', 'Sync from bbm-infrastructure@bbbb')
        r = check(snap, home, cache, url)
        ok(r['stale'] == ['alpha'] and r['fresh'] == ['beta'], 'only the changed mod is stale')
        ok('bbbb' in r['mirror'], 'second fetch sees the new head')

        # A new file counts as a change too.
        write(f'{mirror}/claude-mods/beta/hooks/extra.py', 'x = 1\n')
        sh(mirror, 'git', 'add', '-A')
        sh(mirror, 'git', 'commit', '-qm', 'add file')
        ok(check(snap, home, cache, url)['stale'] == ['alpha', 'beta'], 'an added file makes the mod stale')

        # Fail open, never "fresh".
        r = check(snap, home, os.path.join(tmp, 'cache2'), 'file:///does/not/exist')
        ok(r['fresh'] == [] and r['stale'] == [] and 'mirror unreadable' in r['not_checked'].get('*', ''),
           'unreachable mirror is NOT CHECKED')
        ok('*' in check({}, home, cache, url)['not_checked'], 'missing snapshot is NOT CHECKED')
        r = check({'zeta': 'x'}, home, cache, url)
        ok(r['stale'] == [] and 'nothing was compared' in r['not_checked'].get('*', ''),
           'only unshipped mods loaded: NOT CHECKED, not fresh')
        r = check({**snap, 'zeta': 'x'}, home, cache, url)
        ok('zeta' not in r['stale'] + r['fresh'] and not r['not_checked'], 'an unshipped mod beside shipped ones is ignored')
        r = check('xy', home, cache, url)  # type: ignore[arg-type]
        ok(r['stale'] == r['fresh'] == [] and 'malformed snapshot' in r['not_checked'].get('*', ''),
           'a non-object snapshot is NOT CHECKED')

        # URL follows the marketplace source.
        write(f'{home}/.claude/plugins/known_marketplaces.json',
              json.dumps({MARKETPLACE: {'source': {'source': 'github', 'repo': 'acme/bbm-mods'}}}))
        ok(mirror_url(home) == 'https://github.com/acme/bbm-mods.git', 'mirror URL read from known_marketplaces')
        ok(mirror_url(os.path.join(tmp, 'nohome')) == DEFAULT_URL, 'mirror URL falls back to the default')

        # LC-2217: a project thread loads the claude.ai account copy, with no plugin dirs.
        thome = os.path.join(tmp, 'thread')
        org = f'{thome}/.claude/plugins/synced/org_1'
        shutil.copytree(f'{mirror}/claude-mods/beta', f'{org}/beta')
        write(f'{org}/beta/hooks/__pycache__/x.pyc', 'ignored')
        write(f'{org}/beta/.in_use/1234', '')
        write(f'{org}/data/.claude-plugin/plugin.json', json.dumps({'name': 'data'}))  # an Anthropic plugin
        write(f'{org}/manifest.json', '{}')
        tsnap = snapshot(thome, '')
        ok(sorted(tsnap['loaded']) == ['beta', 'data'] and tsnap['account'] is True, 'thread snapshot reads the account copy')
        ok(snapshot(home, f'{checkout_beta}')['account'] is False, 'a session without the account copy is not flagged')
        r = check(tsnap['loaded'], thome, cache, url, account=True)
        ok(r['fresh'] == ['beta'] and r['missing'] == ['alpha'] and r['account'] is True, 'account copy: unloaded mirror mod is missing')
        ok(check({'beta': snap['beta']}, home, cache, url)['missing'] == [], 'missing is reported only for the account copy')
        write(f'{mirror}/claude-mods/beta/hooks/register.ts', '// beta v2\n')
        sh(mirror, 'git', 'commit', '-qam', 'beta v2')
        ok(check(tsnap['loaded'], thome, cache, url, account=True)['stale'] == ['beta'], 'account copy behind the mirror is stale')
        both = snapshot(thome, f'{checkout_beta}')['loaded']
        ok(both['beta'] == digest_files(read_dir(checkout_beta)), 'a plugin dir shadows the account copy')

        # Board request #72: a thread that synced before the mirror head is not proof the account copy is behind.
        write(f'{thome}/.claude/plugins/synced/org_1/manifest.json', json.dumps({'lastUpdated': 1795214168321}))
        ok(snapshot(thome, '')['synced_at'] == '2026-11-20T22:36:08.321000+00:00', 'snapshot reads the thread sync time')
        ok(snapshot(home, f'{checkout_beta}')['synced_at'] is None, 'no sync time outside the account copy')
        r = check(tsnap['loaded'], thome, cache, url, account=True, synced='2000-01-01T00:00:00+00:00')
        ok(r['stale'] == ['beta'] and r['account_behind'] is False, 'thread synced before the mirror head: not account_behind')
        r = check(tsnap['loaded'], thome, cache, url, account=True, synced='2999-01-01T00:00:00+00:00')
        ok(r['account_behind'] is True, 'thread synced after the mirror head and still stale: account_behind')
        r = check(tsnap['loaded'], thome, cache, url, account=True, synced=None)
        ok(r['account_behind'] is True, 'unknown sync time stays account_behind (louder, never silent)')
        ok(check(tsnap['loaded'], thome, cache, url, account=True, synced='garbage')['account_behind'] is True,
           'unparseable sync time stays account_behind')
        ok(_when('2026-11-20T22:21:52+00:00') is not None and _when('2026-11-20T22:21:52') is None, 'naive times are refused')

        # main() end to end over stdin.
        proc = subprocess.run([sys.executable, '-I', os.path.abspath(__file__)], capture_output=True, text=True,
                              input=json.dumps({'mode': 'check', 'loaded': snap, 'home': home,
                                                'cache_dir': cache, 'mirror_url': url}))
        out = json.loads(proc.stdout)
        ok(proc.returncode == 0 and out['stale'] == ['alpha', 'beta'], 'main() check over stdin')
        proc = subprocess.run([sys.executable, '-I', os.path.abspath(__file__)], capture_output=True, text=True,
                              input='not json')
        ok(proc.returncode == 0 and '*' in json.loads(proc.stdout)['not_checked'], 'main() fails open on bad input')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f'selftest: {passed}/{total} checks passed')
    return 0 if passed == total else 1


if __name__ == '__main__':
    sys.exit(selftest() if '--selftest' in sys.argv else main())
