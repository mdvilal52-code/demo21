#!/usr/bin/env node
// Single-process production entrypoint for platforms that only run one
// Web Service with a plain `npm start` (no Blueprint, no per-app services —
// see render.yaml for the alternative multi-service deployment).
//
// Runs pending migrations, then the API server and the BullMQ worker as two
// child processes in the same container, so both the HTTP API (all four
// journey steps) and Phase 1's post-enquiry background processing work from
// one deployed service. This does not start apps/web (the Next.js browser
// UI) — that is a separate frontend app with its own server/port, not
// something that can share this process's single listening port.
//
// No new dependency: two child processes + signal forwarding is the whole
// job, not enough to justify pulling in a process manager.
import { spawn } from 'node:child_process';

function run(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    console.error(`[${name}] exited (code=${code}, signal=${signal})`);
    // Either process exiting means the deployment is unhealthy — let the
    // platform's restart policy handle recovery rather than limping along
    // with only one of the two running.
    process.exit(code ?? 1);
  });
  return child;
}

function shutdown(children) {
  for (const child of children) child.kill('SIGTERM');
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

  const children = [
    run('api', 'node', ['apps/api/dist/server.js']),
    run('worker', 'node', ['apps/worker/dist/worker.js']),
  ];

  process.on('SIGTERM', () => shutdown(children));
  process.on('SIGINT', () => shutdown(children));
}

main().catch((error) => {
  console.error('Fatal error starting the combined production process', error);
  process.exit(1);
});
