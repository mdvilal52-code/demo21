#!/usr/bin/env node
// Single-process production entrypoint for platforms that only run one Web
// Service with a plain `npm start` (no Blueprint, no per-app services — see
// render.yaml for the alternative multi-service deployment).
//
// Runs pending migrations, then starts three things inside this one
// container: the Fastify API, the Next.js web UI, and the BullMQ worker.
// The API and web UI each bind to a fixed internal (loopback-only) port;
// a small reverse proxy in front of them binds the platform-assigned
// `PORT` and routes each request to whichever one owns that path. This is
// the only way to expose two independent HTTP servers through the one
// port a "Web Service" gives you.
//
// No new dependency: Node's own `http` module is enough for a byte-for-byte
// passthrough proxy (no websockets to handle — `next start` in production
// doesn't use them; that's dev-only HMR).
import { spawn } from 'node:child_process';
import http from 'node:http';

const INTERNAL_API_PORT = 4001;
const INTERNAL_WEB_PORT = 3001;
const PUBLIC_PORT = process.env.PORT || 10000;

// Every path apps/api registers (see apps/api/src/app.ts) — anything else
// belongs to the web UI, including its own /api/enquiries route.
function isApiPath(url) {
  return (
    url === '/health' ||
    url === '/live' ||
    url === '/ready' ||
    url.startsWith('/v1/') ||
    url === '/docs' ||
    url.startsWith('/docs/')
  );
}

function run(name, command, args, envOverrides = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...envOverrides },
    // Its own process group, not just its own process: `web` runs through
    // pnpm -> sh -> next-server, and pnpm does not forward signals to what
    // it spawns. Killing the whole group (see shutdown()) is what actually
    // reaches next-server instead of orphaning it.
    detached: true,
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited unexpectedly (code=${code}, signal=${signal})`);
    // One of the three dying means the deployment is unhealthy — let the
    // platform's restart policy handle recovery rather than limping along.
    shutdown(1);
  });
  return child;
}

async function waitForReady(url, { timeoutMs = 45_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet — keep polling until the deadline.
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${url} to become ready after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function proxyTo(targetPort, req, res) {
  const upstreamReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res, { end: true });
    },
  );
  upstreamReq.on('error', (error) => {
    console.error(`[proxy] upstream ${targetPort} error for ${req.method} ${req.url}`, error);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(
      JSON.stringify({
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Service temporarily unavailable' },
      }),
    );
  });
  req.pipe(upstreamReq, { end: true });
}

function createProxyServer() {
  return http.createServer((req, res) => {
    const url = req.url ?? '/';
    proxyTo(isApiPath(url) ? INTERNAL_API_PORT : INTERNAL_WEB_PORT, req, res);
  });
}

let shuttingDown = false;
let children = [];
let proxyServer;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`Shutting down (exitCode=${exitCode})...`);
  proxyServer?.close();
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  const forceExit = setTimeout(() => process.exit(exitCode), 10_000);
  forceExit.unref();
  Promise.allSettled(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.on('exit', resolve);
        }),
    ),
  ).then(() => process.exit(exitCode));
}

async function main() {
  const migrate = spawn(
    'pnpm',
    ['--filter', '@ai-concierge/db', 'exec', 'prisma', 'migrate', 'deploy'],
    { stdio: 'inherit' },
  );
  const migrateExitCode = await new Promise((resolve) => migrate.on('exit', resolve));
  if (migrateExitCode !== 0) {
    console.error(`Migration failed with exit code ${migrateExitCode}`);
    process.exit(migrateExitCode ?? 1);
  }

  children = [
    run('api', 'node', ['apps/api/dist/server.js'], {
      API_PORT: String(INTERNAL_API_PORT),
      API_HOST: '127.0.0.1',
    }),
    run('web', 'pnpm', ['--filter', '@ai-concierge/web', 'run', 'start'], {
      PORT: String(INTERNAL_WEB_PORT),
      // Loopback call within the same container — always correct here,
      // regardless of whatever public URL might otherwise be configured.
      INTERNAL_API_BASE_URL: `http://127.0.0.1:${INTERNAL_API_PORT}`,
      OUTBOUND_ALLOWED_HOSTS: '127.0.0.1,localhost',
    }),
    run('worker', 'node', ['apps/worker/dist/worker.js']),
  ];

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  try {
    await Promise.all([
      waitForReady(`http://127.0.0.1:${INTERNAL_API_PORT}/health`),
      waitForReady(`http://127.0.0.1:${INTERNAL_WEB_PORT}/`),
    ]);
  } catch (error) {
    console.error('API or web UI never became ready', error);
    shutdown(1);
    return;
  }

  proxyServer = createProxyServer();
  proxyServer.listen(PUBLIC_PORT, () => {
    console.error(
      `[proxy] listening on ${PUBLIC_PORT} (api -> ${INTERNAL_API_PORT}, web -> ${INTERNAL_WEB_PORT})`,
    );
  });
}

main().catch((error) => {
  console.error('Fatal error starting the combined production process', error);
  process.exit(1);
});
