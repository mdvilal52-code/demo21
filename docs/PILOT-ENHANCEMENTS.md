# Pilot enhancements — contact capture, automatic notifications, car photos

Scope: journey Steps 1-8 and their surrounding channels only. Steps 9-19 (documents,
payment, invoice, booking confirmation) are deliberately **not** built.

## What changed

| Area | Before | Now |
| --- | --- | --- |
| Customer contact | Web chat customers were only `web:<random id>`; nothing to email or text. | Email, phone and "my name is …" typed in chat are saved to the CRM. Email/WhatsApp customers get their address/number from the channel itself. After a quote or hand-over the website chat asks for email + phone (at most twice). |
| Automatic email / SMS | Email only replied to inbound email; SMS only paged staff. | When a quote is issued, the customer is emailed and texted it (once per quote). When a person takes the request, the customer is told by email and SMS (once per journey). Nothing goes to the channel the customer is already chatting on. |
| Honesty | — | An unconfigured provider is recorded as `NOT_CONFIGURED`, never a fake success. Each attempt is in `notification_deliveries`. |
| Abuse protection | — | Customer-supplied numbers/emails are capped: 5 per recipient per day per medium, 300 SMS and 1000 emails per day overall (`NOTIFY_*` env). Redis stores only hashes. Fails closed if Redis is down. |
| CRM timeline | `JOURNEY_STARTED` repeated on every message. | Recorded once per journey. |
| Fleet | Read-only; cars came from a seed script. | Admin/Manager can add a car (name, specs, daily rate, number of units), edit rate/availability/active, and manage up to 8 photos per car from the dashboard **Fleet** page. |
| Car photos in chat | — | "Send me a photo of the Range Rover", "urus ki photo dikhao", "show me all your cars" → the concierge attaches the stored photos (web chat inline, WhatsApp as image messages, email as links). Only uploaded photos are ever sent. "Photo of my passport" is not treated as a car photo request. |

## New API

- `POST /v1/fleet/vehicles` · `POST /v1/fleet/vehicles/:id` · `POST /v1/fleet/vehicles/:id/photos` (raw image body) · `POST /v1/fleet/photos/:id/delete` — need `fleet:write` (ADMIN, MANAGER).
- `GET /media/vehicles/:photoId` — public, UUID-addressed, served with the verified image type, `nosniff`, `default-src 'none'; sandbox`.
- `GET /v1/vehicles` now includes each car's `photos`. Chat replies and history include `attachments`. `Customer` includes `email` and `phone`.

Uploads are verified from the file's bytes (JPEG/PNG/WebP only), capped at 4 MB, written under
`MEDIA_ROOT` with generated names, and removed again if the database insert fails.

## Database migration `20260927000000_add_contact_photos_notifications`

Additive only: `customers.email/phone`, `outbound_messages.attachments`, tables `vehicle_photos`
and `notification_deliveries` (RLS + least-privilege grants like every other table). Old code keeps
working against the new schema, so it can be rolled back without a down-migration.

## Configuration

| Variable | Purpose |
| --- | --- |
| `API_PUBLIC_URL` | Must be the public **https** address (photo URLs are built from it). |
| `MEDIA_ROOT` | Folder for uploaded photos; writable, persistent, **included in backups**. |
| `NOTIFY_PER_RECIPIENT_PER_DAY`, `NOTIFY_SMS_GLOBAL_PER_DAY`, `NOTIFY_EMAIL_GLOBAL_PER_DAY` | Caps above (defaults 5 / 300 / 1000). |
| `MAILGUN_*`, `TWILIO_*` | Needed for real emails / SMS. Without them the flow runs and records `NOT_CONFIGURED`. |
| `GEMINI_API_KEY` | Optional; replies stay on the deterministic templates without it. |

nginx must allow photo uploads (the default `client_max_body_size 1m` rejects them):

```nginx
location /v1/fleet/vehicles/ {
    client_max_body_size 5m;
    limit_req zone=api_zone burst=40 nodelay;
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Known limits

- Photos live on the API server's disk (one server). Move `MediaStorage` to object storage before running more than one API instance.
- Customer SMS/email content is fixed text; it does not carry the car photos.
- A customer can still type someone else's number; the caps bound the damage, they do not prove ownership.
