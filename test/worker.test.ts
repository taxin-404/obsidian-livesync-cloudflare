import { env } from 'cloudflare:workers';
import { SELF, reset } from 'cloudflare:test';
import PouchDB from 'pouchdb-core';
import HttpPouch from 'pouchdb-adapter-http';
import find from 'pouchdb-find';
import mapreduce from 'pouchdb-mapreduce';
import replication from 'pouchdb-replication';
import { afterEach, describe, expect, it } from 'vitest';
import { createSetupTicket } from '../src/landing';

PouchDB.plugin(HttpPouch).plugin(find).plugin(mapreduce).plugin(replication);

const username = 'admin';
const password = 'test-password';
const authorization = `Basic ${btoa(`${username}:${password}`)}`;
let nextDatabase = 0;

afterEach(async () => {
  await reset();
});

function databaseName(prefix: string): string {
  nextDatabase += 1;
  return `${prefix}-${nextDatabase}`;
}

function workerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return SELF.fetch(new Request(input, init));
}

function remote(name: string): PouchDB.Database<Record<string, unknown>> {
  return new PouchDB(`https://pouch.test/${name}`, {
    adapter: 'http',
    auth: { username, password },
    fetch: workerFetch,
  } as PouchDB.Configuration.RemoteDatabaseConfiguration);
}

async function couchFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', authorization);
  return SELF.fetch(new Request(`https://pouch.test${path}`, { ...init, headers }));
}

describe('CouchDB compatibility surface', () => {
  it('requires credentials and exposes the CouchDB and LiveSync configuration probes', async () => {
    const denied = await SELF.fetch('https://pouch.test/');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('Basic');

    const root = await couchFetch('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('server')).toContain('CouchDB');
    expect(await root.json()).toMatchObject({ couchdb: 'Welcome' });

    const config = await couchFetch('/_node/_local/_config');
    expect(await config.json()).toMatchObject({
      admins: { admin: '-hashed-' },
      chttpd: { require_valid_user: 'true', enable_cors: 'true' },
      cors: { credentials: 'true' },
    });

    const preflight = await SELF.fetch('https://pouch.test/db/_changes', {
      method: 'OPTIONS',
      headers: {
        origin: 'app://obsidian.md',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('app://obsidian.md');
  });

  it('requires the page password before showing the setup details', async () => {
    const form = await SELF.fetch(new Request('https://pouch.test/', {
      headers: { accept: 'text/html,application/xhtml+xml' },
    }));
    expect(form.status).toBe(200);
    expect(form.headers.get('x-robots-tag')).toContain('noindex');
    expect(form.headers.get('x-frame-options')).toBe('DENY');
    expect(form.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const formHtml = await form.text();
    expect(formHtml).toContain('name="password"');
    expect(formHtml).not.toContain('obsidian://setuplivesync');

    const wrong = await SELF.fetch(new Request('https://pouch.test/', {
      method: 'POST',
      redirect: 'manual',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=nope',
    }));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain('obsidian://setuplivesync');

    const ok = await SELF.fetch(new Request('https://pouch.test/', {
      method: 'POST',
      redirect: 'manual',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=test-password',
    }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/');
    expect(ok.headers.get('cache-control')).toContain('no-store');
    expect(await ok.text()).toBe('');

    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-livesync_setup=');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=60');
    expect(setCookie).toContain('Secure');
    expect(setCookie).not.toContain('Domain=');
    const cookiePair = setCookie.split(';', 1)[0];

    const setup = await SELF.fetch(new Request('https://pouch.test/', {
      headers: { accept: 'text/html', cookie: cookiePair },
    }));
    expect(setup.status).toBe(200);
    expect(setup.headers.get('cache-control')).toContain('no-store');
    expect((setup.headers.get('vary') ?? '').toLowerCase()).toContain('cookie');
    const html = await setup.text();
    expect(html).toContain('obsidian://setuplivesync?settings=test');
    expect(html).toContain('test-uri-passphrase');
    expect(html).toContain("addEventListener('pageshow'");
    const clear = setup.headers.get('set-cookie') ?? '';
    expect(clear).toContain('__Host-livesync_setup=');
    expect(clear).toContain('Max-Age=0');

    const afterClear = await SELF.fetch(new Request('https://pouch.test/', {
      headers: { accept: 'text/html' },
    }));
    expect(await afterClear.text()).toContain('name="password"');

    const tampered = `${cookiePair.slice(0, -1)}${cookiePair.endsWith('A') ? 'B' : 'A'}`;
    const tamperedPage = await SELF.fetch(new Request('https://pouch.test/', {
      headers: { accept: 'text/html', cookie: tampered },
    }));
    expect(await tamperedPage.text()).toContain('name="password"');
    expect(tamperedPage.headers.get('set-cookie')).toContain('Max-Age=0');

    const expiredTicket = await createSetupTicket('test-password', Date.now() - 61_000);
    const expiredPage = await SELF.fetch(new Request('https://pouch.test/', {
      headers: { accept: 'text/html', cookie: `__Host-livesync_setup=${expiredTicket}` },
    }));
    expect(await expiredPage.text()).toContain('name="password"');
  });

  it('supports the PouchDB HTTP document, bulk, changes, and attachment APIs', async () => {
    const db = remote(databaseName('lifecycle'));
    const created = await db.put({
      _id: 'note.md',
      type: 'plain',
      data: 'first',
    });
    expect(created.ok).toBe(true);

    const attachmentPut = await couchFetch(`/lifecycle-${nextDatabase}/note.md/meta.txt?rev=${created.rev}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'attachment body',
    });
    expect(attachmentPut.status).toBe(201);

    const stored = await db.get('note.md');
    expect(stored.data).toBe('first');
    expect(stored._attachments?.['meta.txt']).toMatchObject({ content_type: 'text/plain', stub: true });
    const attachment = await couchFetch(`/lifecycle-${nextDatabase}/note.md/meta.txt`);
    expect(await attachment.text()).toBe('attachment body');

    const bulk = await db.bulkDocs([
      { _id: 'h:orphan', type: 'leaf', data: 'chunk' },
      { _id: 'parent', type: 'plain', children: ['h:used'] },
      { _id: 'h:used', type: 'leaf', data: 'used chunk' },
    ]);
    expect(bulk).toHaveLength(3);

    const all = await db.allDocs({ include_docs: true, keys: ['note.md', 'parent'] });
    expect(all.rows.map((row) => row.key)).toEqual(['note.md', 'parent']);

    const nonLeaves = await db.changes({ since: 0, include_docs: true, selector: { type: { $ne: 'leaf' } } });
    expect(nonLeaves.results.map((change) => change.id)).toEqual(['note.md', 'parent']);

    const info = await db.info();
    expect(info.doc_count).toBe(4);
    expect(await db.compact()).toMatchObject({ ok: true });
    await db.close();
  });

  it('returns 413 before writes exceed Durable Object SQLite value limits', async () => {
    const name = databaseName('limits');
    const db = remote(name);
    const created = await db.put({ _id: 'attachment-target', type: 'plain' });
    const attachment = await couchFetch(`/${name}/attachment-target/large.bin?rev=${created.rev}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(900_001),
    });
    expect(attachment.status).toBe(413);

    const document = await couchFetch(`/${name}/too-large`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'plain', data: 'x'.repeat(1_800_001) }),
    });
    expect(document.status).toBe(413);
  });

  it('paginates selector-filtered changes without skipping matching rows', async () => {
    const name = databaseName('changes');
    const db = remote(name);
    await db.bulkDocs([
      { _id: 'a', type: 'plain' },
      { _id: 'b', type: 'leaf' },
      { _id: 'c', type: 'plain' },
      { _id: 'd', type: 'plain' },
    ]);

    const first = await couchFetch(`/${name}/_changes?since=0&limit=2&include_docs=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: { type: { $ne: 'leaf' } } }),
    });
    const page1 = await first.json() as { results: Array<{ id: string }>; last_seq: number; pending: number };
    expect(page1.results.map((row) => row.id)).toEqual(['a', 'c']);
    expect(page1.pending).toBe(1);

    const second = await couchFetch(`/${name}/_changes?since=${page1.last_seq}&limit=2&include_docs=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: { type: { $ne: 'leaf' } } }),
    });
    const page2 = await second.json() as { results: Array<{ id: string }> };
    expect(page2.results.map((row) => row.id)).toEqual(['d']);
  });

  it('supports longpoll and LiveSync fast-fetch continuous change feeds', async () => {
    const name = databaseName('feeds');
    const db = remote(name);
    await db.put({ _id: 'initial', type: 'plain' });

    const longpollPromise = couchFetch(`/${name}/_changes?feed=longpoll&since=now&include_docs=true&timeout=5000`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await db.put({ _id: 'arrived', type: 'plain' });
    const longpoll = await longpollPromise;
    expect((await longpoll.json() as { results: Array<{ id: string }> }).results.map((row) => row.id)).toEqual(['arrived']);

    const continuous = await couchFetch(`/${name}/_changes?feed=continuous&since=0&limit=10&include_docs=true&style=all_docs&conflicts=true&revs=true`);
    const lines = (await continuous.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.slice(0, -1).map((line) => line.id)).toEqual(['initial', 'arrived']);
    expect(lines[0].doc).toMatchObject({ _id: 'initial', _revisions: { start: 1 } });
    expect(lines.at(-1)).toMatchObject({ last_seq: 2, pending: 0 });
  });

  it('reads _all_docs keys supplied as a query parameter', async () => {
    const name = databaseName('all-docs-keys');
    const db = remote(name);
    await db.bulkDocs([
      { _id: 'version', type: 'plain', value: 1 },
      { _id: 'other', type: 'plain', value: 2 },
    ]);

    const keys = JSON.stringify(['version', 'missing']);
    const response = await couchFetch(`/${name}/_all_docs?keys=${encodeURIComponent(keys)}&include_docs=true`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      rows: Array<{ key: string; doc?: { value?: number }; error?: string }>;
    };
    expect(body.rows.map((row) => row.key)).toEqual(['version', 'missing']);
    expect(body.rows[0].doc).toMatchObject({ _id: 'version', value: 1 });
    expect(body.rows[1]).toMatchObject({ key: 'missing', error: 'not_found' });
  });

  it('replicates between two HTTP databases using PouchDB replication', async () => {
    const source = remote(databaseName('source'));
    const target = remote(databaseName('target'));
    await source.bulkDocs([
      { _id: 'notes/a.md', type: 'plain', data: 'alpha' },
      { _id: 'h:chunk', type: 'leaf', data: 'payload' },
    ]);

    const result = await (PouchDB as typeof PouchDB & {
      replicate(
        source: PouchDB.Database,
        target: PouchDB.Database
      ): Promise<{ ok: boolean; docs_written: number }>;
    }).replicate(source, target);
    expect(result.ok).toBe(true);
    expect(result.docs_written).toBe(2);
    expect((await target.get('notes/a.md')).data).toBe('alpha');
    expect((await target.get('h:chunk')).data).toBe('payload');

    const note = await source.get('notes/a.md');
    await source.remove(note);
    const deletion = await (PouchDB as typeof PouchDB & {
      replicate(
        source: PouchDB.Database,
        target: PouchDB.Database
      ): Promise<{ ok: boolean; docs_written: number }>;
    }).replicate(source, target);
    expect(deletion).toMatchObject({ ok: true, docs_written: 1 });
    await expect(target.get('notes/a.md')).rejects.toMatchObject({ status: 404 });
  });

  it('implements the Mango subset and LiveSync dangling-chunk view and purge', async () => {
    const name = databaseName('livesync');
    const db = remote(name);
    await db.bulkDocs([
      { _id: 'h:orphan', type: 'leaf' },
      { _id: 'h:used', type: 'leaf' },
      { _id: 'parent', type: 'plain', children: ['h:used'] },
    ]);

    const found = await db.find({ selector: { _id: { $gt: 'h:', $lt: 'h:\uffff' }, type: 'leaf' } });
    expect(found.docs.map((doc) => doc._id)).toEqual(['h:orphan', 'h:used']);

    await db.put({
      _id: '_design/chunks',
      ver: 2,
      views: { collectDangling: { map: 'function (doc) { emit([doc._id], 0); }', reduce: '_sum' } },
    });
    const rows = (await (db as PouchDB.Database<Record<string, unknown>> & {
      query(name: string, options: Record<string, unknown>): Promise<{ rows: unknown[] }>;
    }).query('chunks/collectDangling', { reduce: true, group: true })).rows as Array<{
      id: string;
      key: string[];
      value: number;
    }>;
    expect(rows).toContainEqual({ id: 'h:orphan', key: ['h:orphan'], value: 0 });
    expect(rows).toContainEqual({ id: 'h:used', key: ['h:used'], value: 1 });

    const orphan = await db.get('h:orphan');
    const purge = await couchFetch(`/${name}/_purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'h:orphan': [orphan._rev] }),
    });
    expect(purge.status).toBe(200);
    await expect(db.get('h:orphan')).rejects.toMatchObject({ status: 404 });
  });

  it('offers typed Durable Object RPC for other Workers', async () => {
    const name = databaseName('rpc');
    const stub = env.POUCH_DATABASES.getByName(name) as unknown as {
      ensureDatabase(name: string): Promise<void>;
      putDocument(name: string, document: Record<string, unknown>): Promise<PouchDB.Core.Response>;
      getDocument(name: string, id: string): Promise<Record<string, unknown>>;
      allDocuments(name: string): Promise<{ rows: Array<{ id: string }> }>;
    };
    await stub.ensureDatabase(name);
    await stub.putDocument(name, { _id: 'from-worker', type: 'plain', data: 'value' });
    expect(await stub.getDocument(name, 'from-worker')).toMatchObject({ data: 'value' });
    expect((await stub.allDocuments(name)).rows.map((row) => row.id)).toEqual(['from-worker']);
  });
});

describe('replication and maintenance regressions', () => {
  it('streams complete and descending feeds and pages sparse matching conflicts without skipping', async () => {
    const name = databaseName('bounded');
    const db = remote(name);
    await db.bulkDocs(Array.from({ length: 130 }, (_, index) => ({ _id: `d${String(index).padStart(3, '0')}`, chosen: index % 17 === 0 })));
    const complete = await (await couchFetch(`/${name}/_changes`)).json() as { results: Array<{ id: string; seq: number }> };
    expect(complete.results).toHaveLength(130);
    const descending = await (await couchFetch(`/${name}/_changes?descending=true`)).json() as typeof complete;
    expect(descending.results.map((row) => row.id)).toEqual(complete.results.map((row) => row.id).reverse());
    for (const filtered of [false, true]) {
      let checkpoint = 0;
      let pending = Infinity;
      const ids: string[] = [];
      for (let page = 0; page < 100 && pending > 0; page++) {
        const result = await (await couchFetch(`/${name}/_changes?descending=true&limit=3&since=${checkpoint}`, {
          method: 'POST', body: JSON.stringify(filtered ? { selector: { chosen: true } } : {}),
        })).json() as { results: Array<{ id: string }>; last_seq: number; pending: number };
        expect(result.results.length).toBeLessThanOrEqual(3);
        expect(result.pending).toBeLessThan(pending);
        ids.push(...result.results.map((row) => row.id)); checkpoint = result.last_seq; pending = result.pending;
      }
      const expected = complete.results.filter((_, index) => !filtered || index % 17 === 0).map((row) => row.id).reverse();
      expect(ids).toEqual(expected);
      const exhausted = await (await couchFetch(`/${name}/_changes?descending=true&since=${checkpoint}`)).json();
      expect(exhausted).toMatchObject({ results: [], last_seq: checkpoint, pending: 0 });
    }
    let since = 0;
    const seen: string[] = [];
    for (let page = 0; page < 10; page++) {
      const result = await (await couchFetch(`/${name}/_changes?since=${since}&limit=2`, {
        method: 'POST', body: JSON.stringify({ selector: { chosen: true } }),
      })).json() as { results: Array<{ id: string }>; last_seq: number; pending: number };
      seen.push(...result.results.map((row) => row.id)); since = result.last_seq;
      if (!result.pending) break;
    }
    expect(seen).toEqual(Array.from({ length: 8 }, (_, index) => `d${String(index * 17).padStart(3, '0')}`));
    const zero = await (await couchFetch(`/${name}/_changes?limit=0`)).json() as typeof complete;
    expect(zero.results).toHaveLength(1);
    for (const limit of ['-1', '1.5', 'nope', '']) expect((await couchFetch(`/${name}/_changes?limit=${limit}`)).status).toBe(400);
    expect((await couchFetch(`/${name}/_changes`, { method: 'POST', body: JSON.stringify({ selector: { chosen: { $regex: 'x' } } }) })).status).toBe(400);
    await db.bulkDocs([
      { _id: 'conflict', _rev: '1-aaaa', selected: true },
      { _id: 'conflict', _rev: '1-zzzz', selected: false },
    ], { new_edits: false });
    const conflict = await (await couchFetch(`/${name}/_changes?style=all_docs&include_docs=true`, {
      method: 'POST', body: JSON.stringify({ selector: { selected: true } }),
    })).json() as { results: Array<{ changes: Array<{ rev: string }>; doc: { selected: boolean } }> };
    expect(conflict.results).toHaveLength(1);
    expect(conflict.results[0]).toMatchObject({ changes: [{ rev: '1-aaaa' }], doc: { selected: false } });
    expect(await db.get('conflict', { open_revs: 'all' })).toHaveLength(2);
    expect((await couchFetch(`/${name}/conflict?open_revs=nope`)).status).toBe(400);
    await db.close();
  });

  it('protects losing leaves and retained ancestors before allowing chunk cleanup', async () => {
    const name = databaseName('retained');
    const db = remote(name);
    await db.bulkDocs(['left', 'right', 'orphan'].map((key) => ({ _id: `h:${key}`, type: 'leaf', data: key })));
    await db.bulkDocs([
      { _id: 'note.md', _rev: '1-aaaa', path: 'note.md', children: ['h:left'] },
      { _id: 'note.md', _rev: '1-zzzz', path: 'note.md', children: ['h:right'] },
    ], { new_edits: false });
    const view = await (await couchFetch(`/${name}/_design/chunks/_view/collectDangling`)).json() as { rows: Array<{ id: string; value: number }> };
    expect(view.rows.find((row) => row.id === 'h:left')?.value).toBe(1);
    const left = await db.get('h:left'); const orphan = await db.get('h:orphan');
    const purge = (body: object) => couchFetch(`/${name}/_purge`, { method: 'POST', body: JSON.stringify(body) });
    expect((await purge({ 'h:left': [left._rev], 'h:orphan': [orphan._rev] })).status).toBe(409);
    await expect(db.get('h:orphan')).resolves.toBeDefined();
    await db.remove('note.md', '1-aaaa');
    expect((await purge({ 'h:left': [left._rev] })).status).toBe(409);
    await db.compact();
    expect((await purge({ 'h:left': [left._rev] })).status).toBe(200);
    expect((await purge({ 'h:orphan': [orphan._rev] })).status).toBe(200);
    await db.close();
  });
});

describe('health endpoint', () => {
  it('reports liveness and the age of the newest backup without credentials', async () => {
    const listing = await env.BACKUP_BUCKET.list({ prefix: 'backups/' });
    if (listing.objects.length) await env.BACKUP_BUCKET.delete(listing.objects.map((object) => object.key));

    const empty = await (await SELF.fetch('https://pouch.test/_up')).json() as {
      status: string; backup: { lastSuccess: string | null; ageHours: number | null; overdue: boolean };
    };
    expect(empty).toMatchObject({ status: 'ok', backup: { lastSuccess: null, ageHours: null, overdue: true } });

    expect((await couchFetch('/vault', { method: 'PUT' })).status).toBe(201);
    expect((await couchFetch('/_backup', { method: 'POST' })).status).toBe(200);

    const healthy = await (await SELF.fetch('https://pouch.test/_up')).json() as {
      status: string; backup: { lastSuccess: string | null; ageHours: number | null; overdue: boolean };
    };
    expect(healthy.status).toBe('ok');
    expect(healthy.backup.overdue).toBe(false);
    expect(typeof healthy.backup.lastSuccess).toBe('string');
    expect(healthy.backup.ageHours).toBeLessThan(1);
  });
});
