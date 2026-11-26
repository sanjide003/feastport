import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit']
});
const exited = once(server, 'exit');
try {
  const port = await Promise.race([
    once(server.stdout, 'data').then(([chunk]) => {
      const match = /0\.0\.0\.0:(\d+)/.exec(chunk.toString());
      assert.ok(match, 'Expected the development server to announce its address');
      return match[1];
    }),
    exited.then(() => { throw new Error('Server exited before startup'); }),
    delay(10000, null, { ref: false }).then(() => { throw new Error('Startup timed out'); })
  ]);
  const base = 'http://127.0.0.1:' + port;
  for (const page of ['index', 'results', 'register', 'verify', 'login', 'admin', 'team', 'judge', 'tv', 'tv-control']) {
    const response = await fetch(base + '/' + page + '.html');
    assert.equal(response.status, 200, page);
    const html = await response.text();
    assert.match(html, /<html lang="en"/, page);
    assert.match(html, /href="portal.css"/, page);
  }
  for (const path of ['/portal.css', '/styles/festival.css']) {
    const css = await fetch(base + path);
    assert.equal(css.status, 200, path);
    assert.match(css.headers.get('content-type'), /text\/css/, path);
  }
  assert.equal((await fetch(base + '/firebase-runtime-config.js')).headers.get('cache-control'), 'no-store');
  console.log('All ten portal pages, shared styles and runtime configuration passed.');
} finally {
  server.kill();
  await exited;
}
