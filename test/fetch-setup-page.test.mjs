import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fetchSetupPage } from '../scripts/livesync-cli.mjs';

const SETUP_HTML = '<div class="row"><dt>Setup URI</dt><dd id="v-uri">obsidian://setuplivesync?settings=x</dd></div>'
  + '<div class="row"><dt>Passphrase</dt><dd id="v-pass">uri-pass</dd></div>';
const GATE_HTML = '<form method="post"><input type="password" name="password"></form>';

function pageServer() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, cookie: request.headers.cookie ?? null });
    if (request.method === 'POST') {
      response.writeHead(303, {
        location: '/',
        'set-cookie': 'livesync_setup=ticket-value; Path=/; HttpOnly; SameSite=Strict; Max-Age=60',
      });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.headers.cookie === 'livesync_setup=ticket-value' ? SETUP_HTML : GATE_HTML);
  });
  return { server, requests };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}

test('completes the ticket handshake so the setup page is returned', async () => {
  const { server, requests } = pageServer();
  const url = await listen(server);
  try {
    const html = await fetchSetupPage(url, 'test-password');
    assert.match(html, /id="v-uri"/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[1].method, 'GET');
    assert.equal(requests[1].cookie, 'livesync_setup=ticket-value');
  } finally {
    server.close();
  }
});

test('returns a non-redirect response unchanged', async () => {
  const server = createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
    response.end(GATE_HTML);
  });
  const url = await listen(server);
  try {
    const html = await fetchSetupPage(url, 'wrong-password');
    assert.equal(html, GATE_HTML);
  } finally {
    server.close();
  }
});
