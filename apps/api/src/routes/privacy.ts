import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Privacy Policy — AI Concierge</title>
</head>
<body>
<h1>Privacy Policy — AI Concierge</h1>
<p><em>Last updated: 2026-09-20</em></p>

<p>AI Concierge ("we", "us", "our") provides an AI-assisted luxury car rental concierge service
in Dubai, United Arab Emirates, reachable over WhatsApp, our website, and email. This policy
explains what information we collect when you contact us through any of those channels, how we
use it, and the choices you have.</p>

<h2>1. Information We Collect</h2>
<ul>
  <li><strong>Contact information</strong> — your phone number (when you message us on WhatsApp),
  and any name, email address, or contact details you provide through our website or email.</li>
  <li><strong>Message content</strong> — the text of messages you send us, so we can understand
  and respond to your rental enquiry.</li>
  <li><strong>Rental preferences</strong> — pickup/return dates, pickup and drop-off locations,
  and vehicle preferences you share with us.</li>
  <li><strong>Technical data</strong> — standard request logs (timestamps, request identifiers)
  kept for security and reliability; we do not use tracking cookies on this service.</li>
</ul>

<h2>2. How We Use Your Information</h2>
<p>We use the information above to:</p>
<ul>
  <li>Understand and respond to your rental enquiry, including identifying what information is
  still needed to proceed (e.g. missing dates, location, or vehicle preference);</li>
  <li>Communicate with you about your enquiry or booking;</li>
  <li>Maintain an audit record of enquiries for security, dispute resolution, and quality
  purposes;</li>
  <li>Improve our service.</li>
</ul>
<p>We do not sell your personal information, and we do not use your messages to train
general-purpose AI models.</p>

<h2>3. WhatsApp and Other Communication Platforms</h2>
<p>When you message us on WhatsApp, your message is delivered to us through the WhatsApp
Business Platform, operated by Meta Platforms, Inc. Meta's own
<a href="https://www.whatsapp.com/legal/business-policy">WhatsApp Business Messaging Policy</a>
and <a href="https://www.facebook.com/privacy/policy/">Meta Privacy Policy</a> govern how Meta
handles data as part of delivering that message to us. We receive and process the content of
messages sent to our WhatsApp number as described in this policy.</p>

<h2>4. Sharing of Information</h2>
<p>We do not share your personal information with third parties for their own marketing
purposes. We may share information with:</p>
<ul>
  <li>Service providers who host our infrastructure or deliver messages on our behalf (e.g. our
  cloud hosting provider and the WhatsApp Business Platform), solely to operate this service;</li>
  <li>Authorities, where required by applicable law.</li>
</ul>

<h2>5. Data Retention</h2>
<p>We retain enquiry and conversation records for as long as reasonably necessary to fulfil the
purposes described above, including any applicable legal, accounting, or reporting
requirements, after which they are deleted or anonymised.</p>

<h2>6. Data Security</h2>
<p>We apply reasonable technical and organisational measures to protect your information,
including transport encryption (HTTPS/TLS), verified webhook signatures on inbound messages,
and access controls on our systems.</p>

<h2>7. Your Rights</h2>
<p>Depending on your location, you may have the right to request access to, correction of, or
deletion of your personal information. To make such a request, contact us through WhatsApp or
our website using the same channel you originally reached out on.</p>

<h2>8. Children's Privacy</h2>
<p>Our service is intended for adults arranging vehicle rentals and is not directed at children.
We do not knowingly collect personal information from children.</p>

<h2>9. Changes to This Policy</h2>
<p>We may update this policy from time to time. The "Last updated" date above reflects the most
recent revision.</p>

<h2>10. Contact Us</h2>
<p>If you have questions about this policy or how your information is handled, please contact us
through WhatsApp or our website.</p>
</body>
</html>
`;

export const privacyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/privacy', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(PRIVACY_POLICY_HTML);
  });
};
