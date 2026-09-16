# Deployment Guide — AI Concierge

## Architecture Overview

The monorepo deploys across three services with different hosting requirements:

| Service | Type | Host | Why |
|---------|------|------|-----|
| **apps/web** | Next.js frontend | Vercel | Serverless, stateless; perfect fit |
| **apps/api** | Fastify server + Postgres | Render OR Oracle | Persistent process, DB connections, graceful shutdown |
| **apps/worker** | BullMQ background worker | Render OR Oracle | Persistent process, job consumer |

**Key constraint**: apps/api is NOT serverless. It calls `.listen()`, holds database connections, and handles SIGTERM for graceful shutdown. Vercel's request/response model cannot support persistent servers—only Render or Oracle Cloud can.

---

## Path A: Render Blueprint (Recommended for managed hosting)

### Prerequisites
- Render account (free tier available for most components)
- Cost: ~$7/month (worker; everything else free)

### Setup Steps

1. **Copy render.yaml to your repo root** ✓ (already done)

2. **Push your branch to GitHub** ✓ (already done)

3. **In Render Dashboard:**
   - Go to Blueprints → New Blueprint
   - Select your repository and branch `claude/wonderful-noether-2xvhft`
   - Point to `render.yaml` in the root
   - Click Deploy

4. **Render will create four services automatically:**
   - `ai-concierge-db` (Postgres 16, free)
   - `ai-concierge-redis` (Redis, free)
   - `ai-concierge-api` (web service, free)
   - `ai-concierge-worker` (background worker, $7/month)

5. **After initial deploy, set manual env variables:**
   - Go to each service's Settings → Environment
   - Set these per service (from `.env.production.example`):
     - `WEBHOOK_SIGNING_SECRET` (generate: `openssl rand -base64 32`)
     - `DEFAULT_TENANT_ID` (e.g., `00000000-0000-0000-0000-000000000001`)
     - `API_PUBLIC_URL` (e.g., `https://ai-concierge-api-xxxx.onrender.com`)
     - `CORS_ALLOWED_ORIGINS` (e.g., your Vercel app's domain)

6. **Verify deployment:**
   ```bash
   curl https://ai-concierge-api-xxxx.onrender.com/health
   ```
   Should return `200 OK` with observability status.

### Troubleshooting Render

- **"Collection not found" during deploy**: Render's Blueprint syntax may vary by region. Check the logs—if the issue persists, manually create the services instead of using Blueprint.
- **Worker fails to start**: Ensure `REDIS_URL` from the keyvalue service is set correctly.
- **API returns 500**: Check logs for missing `DEFAULT_TENANT_ID` or database migration failures.

---

## Path B: Oracle Cloud Always Free VM (Zero-cost option)

### Prerequisites
- Oracle Cloud account (Always Free tier)
- SSH access to the VM
- Cost: **$0/month** (always free compute; Postgres/Redis run locally via Docker)

### Setup Steps

1. **Create Oracle Cloud Always Free VM**
   - Compute → Instances → Create Instance
   - Image: Ubuntu 22.04 (always free eligible)
   - Shape: Ampere (ARM) A1 (free)
   - Region: US East (Ashburn) recommended
   - Public IP: Enabled
   - Note the public IP address

2. **Add Ingress Rule to allow port 4000**
   - Networking → Virtual Cloud Networks → Select your VCN → Security Lists
   - Add Ingress Rule:
     - Source CIDR: `0.0.0.0/0`
     - Destination Port: `4000`
     - Protocol: TCP
   - Without this, the OS firewall won't matter—Oracle blocks traffic at the network level

3. **SSH into the VM**
   ```bash
   ssh ubuntu@<public-ip>
   ```

4. **Clone the repo and prepare**
   ```bash
   git clone https://github.com/mdvilal52-code/demo21.git /opt/ai-concierge
   cd /opt/ai-concierge
   cp deploy/.env.production.example .env.production
   # Edit .env.production with your values (see below)
   nano .env.production
   ```

5. **Fill in .env.production**
   - `WEBHOOK_SIGNING_SECRET`: `openssl rand -base64 32`
   - `DEFAULT_TENANT_ID`: e.g., `00000000-0000-0000-0000-000000000001`
   - `API_PUBLIC_URL`: `http://<your-vm-public-ip>:4000`
   - `CORS_ALLOWED_ORIGINS`: your Vercel app's domain (e.g., `https://app.example.com`)

6. **Run the provisioning script** (idempotent, safe to re-run)
   ```bash
   sudo bash /opt/ai-concierge/deploy/oracle-vm-setup.sh
   ```
   This will:
   - Install Node.js 22, Docker, pm2
   - Start Postgres + Redis via docker-compose
   - Build apps/api and apps/worker
   - Run database migrations
   - Seed the default tenant
   - Start both services under pm2
   - Add port 4000 to the OS firewall

7. **Verify deployment**
   ```bash
   curl http://localhost:4000/health
   ```
   Should return `200 OK`.

8. **From outside the VM:**
   ```bash
   curl http://<public-ip>:4000/health
   ```

9. **Make pm2 survive VM reboots**
   ```bash
   pm2 startup
   # Copy the exact command pm2 prints and run it
   pm2 save
   ```

### Troubleshooting Oracle VM

- **Connection refused on port 4000**: Check the security list ingress rule (step 2 above).
- **Postgres health check timeout**: The script waits 60s; if it fails, check `docker compose logs postgres`.
- **pm2 services not starting**: Check `.env.production` for missing/invalid values. Run `pm2 logs` to see startup errors.
- **pm2 not surviving reboot**: Run `pm2 startup` and `pm2 save` again.

---

## Connecting apps/web to Your Backend

Once your backend is live, configure apps/web to point to it:

### On Vercel Dashboard:
1. Select your apps/web project
2. Settings → Environment Variables
3. Add `INTERNAL_API_BASE_URL`:
   - **If using Render**: `https://ai-concierge-api-xxxx.onrender.com`
   - **If using Oracle**: `http://<your-vm-public-ip>:4000`

The frontend will now make API calls to your chosen backend.

---

## Choosing Between Paths

| Factor | Render | Oracle |
|--------|--------|--------|
| **Cost** | ~$7/month | $0 (always free) |
| **Setup time** | 5 minutes (UI-driven) | 15 minutes (CLI + provisioning) |
| **Maintenance** | Fully managed (Render handles OS, Postgres versions, etc.) | Manual (you manage OS patches, Postgres upgrades) |
| **Uptime SLA** | Implicit; free tier can sleep after 15 min | Up to you (VM can be restarted) |
| **Learning** | Less involved; ideal for teams | More hands-on; good for understanding the stack |

**Recommendation**: Start with Oracle (free) if you're comfortable with Linux VMs. Use Render if you want managed hosting and can afford ~$7/month.

---

## Environment Variables Reference

Both Render and Oracle need these variables configured. See `deploy/.env.production.example` for detailed descriptions.

```bash
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_concierge
REDIS_URL=redis://localhost:6379
WEBHOOK_SIGNING_SECRET=<generate with: openssl rand -base64 32>
DEFAULT_TENANT_ID=00000000-0000-0000-0000-000000000001
OUTBOUND_ALLOWED_HOSTS=localhost,127.0.0.1
API_PORT=4000
API_HOST=0.0.0.0
API_PUBLIC_URL=<your backend URL>
CORS_ALLOWED_ORIGINS=<your frontend URL>
WORKER_CONCURRENCY=5
```

---

## Post-Deployment Verification

Once backend + frontend are deployed:

1. **Health check from CLI:**
   ```bash
   curl https://<backend-url>/health
   ```

2. **Test the enquiry form:**
   - Visit your Vercel app
   - Submit a sample enquiry
   - Verify it persists (check the backend logs, `curl /v1/enquiries`)

3. **Monitor background processing:**
   - `pm2 logs ai-concierge-worker` (Oracle) or Render Logs (Render)
   - Should see post-enquiry-processing jobs being consumed

---

## Rollback Strategy

### Render
- Revert Blueprint: Change branch in Render dashboard to a previous branch
- Automatic rollback: Render keeps the previous deployment; select "Rollback" from the Services page

### Oracle
- SSH to VM and run `git pull` to fetch previous code, then re-run `deploy/oracle-vm-setup.sh`
- Or SSH and run `pm2 restart ai-concierge-api` to restart the process

---

## Next Steps
1. Choose your backend path (Render or Oracle)
2. Follow the setup steps for your chosen path
3. Set `INTERNAL_API_BASE_URL` on Vercel apps/web
4. Run the post-deployment verification checks
5. Let me know if you hit any blockers!
