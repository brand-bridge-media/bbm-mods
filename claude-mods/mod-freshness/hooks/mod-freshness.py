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
      -> {"loaded": {"<mod>": "<digest>"}}   fingerprint of what was loaded, taken at session start
  {"mode": "check", "loaded": {...}}
      -> {"stale": [...], "fresh": [...], "not_checked": {"<mod>": "<reason>"}, "mirror": "<subject>"}

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
SKIP_DIRS = {'.git', 'node_modules', '__pycache__'}
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


def loaded_dirs(home: str, plugin_dirs: str) -> dict[str, str]:
    """mod name -> the directory its code was loaded from.

    Installed @bbm-mods plugins first; a CLAUDE_CODE_PLUGIN_DIRS entry (bbm-infrastructure
    sessions load the checkout copy) replaces the installed one of the same name.
    """
    out: dict[str, str] = {}
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


def snapshot(home: str, plugin_dirs: str) -> dict:
    loaded = {}
    for name, d in loaded_dirs(home, plugin_dirs).items():
        try:
            loaded[name] = digest_files(read_dir(d))
        except OSError:
            continue
    return {'loaded': loaded}


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


def check(loaded: dict, home: str, cache: str, url: str) -> dict:
    out: dict = {'stale': [], 'fresh': [], 'not_checked': {}, 'mirror': ''}
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
    except (RuntimeError, OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError) as exc:
        out['not_checked']['*'] = f'mirror unreadable: {exc}'
        return out
    for name in sorted(loaded):
        if name not in latest:
            continue  # not a bbm mod, or one the mirror has since dropped
        (out['fresh'] if loaded[name] == latest[name] else out['stale']).append(name)
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
            result = check(payload.get('loaded') or {}, home, cache, payload.get('mirror_url') or mirror_url(home))
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
