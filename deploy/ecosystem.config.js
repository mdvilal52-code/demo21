// pm2 process definitions for running apps/api and apps/worker as persistent,
// auto-restarting services on a plain VM (e.g. an Oracle Cloud Always Free
// instance) — the same two processes Render's Blueprint (render.yaml) runs
// as managed services, here supervised by pm2 instead. See
// deploy/oracle-vm-setup.sh for the full provisioning flow this plugs into.
//
// IMPORTANT: pm2's own `env_file` option does NOT actually load variables
// (verified directly — a process started with it sees them as undefined).
// Instead, .env.production must be sourced into the shell BEFORE running
// `pm2 start` — pm2 then inherits that environment for every app below.
// oracle-vm-setup.sh already does this; if starting manually, run:
//   set -a && source /opt/ai-concierge/.env.production && set +a && pm2 start deploy/ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'ai-concierge-api',
      script: 'apps/api/dist/server.js',
      cwd: '/opt/ai-concierge',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'ai-concierge-worker',
      script: 'apps/worker/dist/worker.js',
      cwd: '/opt/ai-concierge',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
