#!/usr/bin/env python3
"""Turn the self-unpacking design-tool bundles in src/bundles/ into plain
static pages in public/.

A bundle carries every asset base64+gzip encoded and rebuilds the page in
the browser with blob: URLs. That needs DecompressionStream and a CSP that
allows blob: scripts; when either is missing the page shows its raw
{{ template }} text. Writing the assets out as ordinary files avoids both.

Usage: python3 tools/unbundle.py
"""
import base64
import gzip
import hashlib
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src', 'bundles')
OUT = os.path.join(ROOT, 'public')
ASSETS = os.path.join(OUT, 'assets')

PAGES = {
    'landing.html': 'index.html',
    'dashboard.html': 'dashboard.html',
    'admin.html': 'admin.html',
}

EXT = {
    'application/javascript': 'js',
    'text/javascript': 'js',
    'text/css': 'css',
    'image/svg+xml': 'svg',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'font/woff2': 'woff2',
    'font/woff': 'woff',
    'font/ttf': 'ttf',
}


TOOLBAR_MARK = ('<span style="letter-spacing:.1em;text-transform:uppercase;'
                'color:var(--color-accent-300)">Prototype</span>')

# Replaces the design tool's scenario/layout switcher. server.js fills in the
# __AF_USER_*__ placeholders for the signed-in user.
ACCOUNT_BAR = '''<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;padding:8px 20px;background:color-mix(in srgb, var(--color-bg) 55%, transparent);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);font-size:12px;color:var(--color-neutral-300)">
  <span style="letter-spacing:.1em;text-transform:uppercase;color:var(--color-accent-300)">Preview</span>
  <span>Sample data. Your real commissions will show here once the program goes live.</span>
  <span style="margin-left:auto">Signed in as <strong>__AF_USER_EMAIL__</strong></span>
  <a href="/logout" style="text-decoration:none;display:flex;align-items:center;gap:6px">Log out <i class="ph ph-sign-out"></i></a>
</div>

'''


def replace_once(text, old, new, page):
    if text.count(old) != 1:
        raise SystemExit('%s: expected exactly one %r, found %d' % (page, old[:60], text.count(old)))
    return text.replace(old, new)


def patch_dashboard(template):
    start = template.rfind('<div', 0, template.index(TOOLBAR_MARK))
    end = template.index('<nav class="nav"', start)
    template = template[:start] + ACCOUNT_BAR + template[end:]
    # The sample affiliate's name and avatar become the signed-in user's.
    template = template.replace("'Rina Kartika'", '__AF_USER_NAME_JS__')
    template = replace_once(template, '>RK</span>', '>__AF_USER_INITIALS__</span>', 'dashboard')
    return template


PATCHES = {'dashboard.html': patch_dashboard}


def script_block(html, kind):
    m = re.search(r'<script type="__bundler/%s">(.*?)</script>' % re.escape(kind), html, re.S)
    return json.loads(m.group(1)) if m else None


def unbundle(src_path, out_path, patch=None):
    html = open(src_path, encoding='utf-8').read()
    manifest = script_block(html, 'manifest')
    template = script_block(html, 'template')
    if patch:
        template = patch(template)
    ext_resources = script_block(html, 'ext_resources') or []
    if script_block(html, 'page_order'):
        raise SystemExit('%s: nested page bundles are not supported' % src_path)

    urls = {}
    for uuid, entry in manifest.items():
        data = base64.b64decode(entry['data'])
        if entry.get('compressed'):
            data = gzip.decompress(data)
        ext = EXT.get(entry['mime'])
        if not ext:
            raise SystemExit('%s: unknown asset type %s' % (src_path, entry['mime']))
        # Content-addressed, so assets shared between pages are stored once.
        name = '%s.%s' % (hashlib.sha256(data).hexdigest()[:16], ext)
        path = os.path.join(ASSETS, name)
        if not os.path.exists(path):
            with open(path, 'wb') as f:
                f.write(data)
        urls[uuid] = '/assets/' + name

    for uuid, url in urls.items():
        template = template.replace(uuid, url)
    # Same cleanup the in-browser unpacker does before swapping the page in.
    template = re.sub(r'\s+integrity="[^"]*"', '', template, flags=re.I)
    template = re.sub(r'\s+crossorigin="[^"]*"', '', template, flags=re.I)

    # The dc runtime looks up CDN scripts (React, ReactDOM) in
    # window.__resources before falling back to unpkg.
    resources = {e['id']: urls[e['uuid']] for e in ext_resources if e['uuid'] in urls}
    resource_script = '<script>window.__resources = %s;</script>' % (
        json.dumps(resources).replace('</', '<\\/'))
    head = re.search(r'<head[^>]*>', template, re.I)
    if not head:
        raise SystemExit('%s: template has no <head>' % src_path)
    template = template[:head.end()] + resource_script + template[head.end():]

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(template)


def main():
    os.makedirs(ASSETS, exist_ok=True)
    for name in os.listdir(ASSETS):
        os.remove(os.path.join(ASSETS, name))
    for src, out in PAGES.items():
        unbundle(os.path.join(SRC, src), os.path.join(OUT, out), PATCHES.get(src))
        print('%s -> public/%s' % (src, out))


if __name__ == '__main__':
    main()
