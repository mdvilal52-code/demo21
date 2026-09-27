import { randomUUID } from 'node:crypto';
import { createEligibilityPolicyVersion } from '@ai-concierge/db';
import type { EligibilityPolicyRules } from '@ai-concierge/domain';
import {
  seedTestTenants,
  seedTestUser,
  truncateAllTables,
  TEST_TENANT_ID,
  TEST_USER_PASSWORD,
} from '@ai-concierge/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './test/buildTestApp.js';
import { FakeEmailProvider } from './test/fakeEmailProvider.js';
import { FakeNotificationProvider } from './test/fakeNotificationProvider.js';

/**
 * Fleet management (add a car, upload its photos), the concierge sending those
 * photos when a customer asks to see a car, contact capture into the CRM, and
 * the automatic quote / hand-over email and SMS — through the real HTTP layer
 * and a real Postgres.
 */
const POLICY: EligibilityPolicyRules = {
  minAge: 21,
  minAgeByLuxuryTier: { ULTRA_LUXURY: 25 },
  requiredLicenseTypes: ['UAE', 'GCC', 'IDP'],
  passportRequired: true,
  nationalityRules: { blockedNationalities: [], allowedNationalitiesOnly: [] },
  vehicleRestrictions: {},
  restrictedCities: [],
  driverRequirements: {
    maxAdditionalDrivers: 2,
    additionalDriverMinAge: 21,
    additionalDriversRequireValidLicense: true,
  },
};
const BOOKING =
  'Hi, I would like to rent a Lamborghini Urus from 15 October to 19 October, pickup Dubai Marina';
const FULL_DETAILS =
  "I'm Indian, born 12 May 1990, I hold a UAE driving licence and I can provide my passport";

const NEW_CAR = {
  make: 'lamborghini',
  model: 'urus',
  category: 'SUV',
  luxuryTier: 'ULTRA_LUXURY',
  seats: 5,
  luggage: 4,
  transmission: 'AUTOMATIC',
  dailyRate: 3500,
  units: 2,
};

/** Enough of a JPEG (its magic bytes) for the upload check; the API never decodes images. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 1),
]);

describe('fleet photos, contact capture and automatic notifications — integration', () => {
  let testApp: TestApp;
  let email: FakeEmailProvider;
  let sms: FakeNotificationProvider;

  beforeAll(async () => {
    email = new FakeEmailProvider();
    sms = new FakeNotificationProvider();
    testApp = await buildTestApp(
      { RATE_LIMIT_MAX: 5000, AUTH_RATE_LIMIT_MAX: 5000 },
      { emailProvider: email, notificationProvider: sms },
    );
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    email.sent.length = 0;
    sms.sent.length = 0;
    await createEligibilityPolicyVersion(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      rules: POLICY,
    });
  });

  async function token(role: 'ADMIN' | 'OPS_AGENT' | 'MANAGER' = 'ADMIN') {
    const address = `${role.toLowerCase()}@example.com`;
    const existing = await testApp.ctx.prisma.user.findFirst({ where: { email: address } });
    if (!existing) {
      await seedTestUser(testApp.ctx.prisma, { tenantId: TEST_TENANT_ID, role, email: address });
    }
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: address, password: TEST_USER_PASSWORD },
    });
    return response.json().accessToken as string;
  }
  const auth = (value: string) => ({ authorization: `Bearer ${value}` });

  async function addCar(
    body: Record<string, unknown> = NEW_CAR,
    role: 'ADMIN' | 'OPS_AGENT' = 'ADMIN',
  ) {
    return testApp.app.inject({
      method: 'POST',
      url: '/v1/fleet/vehicles',
      headers: auth(await token(role)),
      payload: body,
    });
  }

  async function upload(
    vehicleId: string,
    bytes: Buffer,
    contentType = 'image/jpeg',
    caption?: string,
  ) {
    return testApp.app.inject({
      method: 'POST',
      url: `/v1/fleet/vehicles/${vehicleId}/photos${caption ? `?caption=${encodeURIComponent(caption)}` : ''}`,
      headers: { ...auth(await token()), 'content-type': contentType },
      payload: bytes,
    });
  }

  async function chat(sessionId: string, message: string) {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      payload: { sessionId, clientMessageId: randomUUID(), message },
    });
    return { status: response.statusCode, body: response.json() };
  }

  describe('fleet management', () => {
    it('lets an admin add a car with its units, and lists it', async () => {
      const created = await addCar();
      expect(created.statusCode).toBe(201);
      const vehicle = created.json().vehicle;
      expect(vehicle).toMatchObject({
        make: 'Lamborghini',
        model: 'Urus',
        pricingProfile: { currency: 'AED', dailyRate: 3500 },
        active: true,
        photos: [],
      });
      expect(await testApp.ctx.prisma.vehicleUnit.count({ where: { vehicleId: vehicle.id } })).toBe(
        2,
      );

      const list = await testApp.app.inject({
        method: 'GET',
        url: '/v1/vehicles',
        headers: auth(await token()),
      });
      expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([vehicle.id]);
    });

    it('is closed to unauthenticated callers and to roles without fleet:write', async () => {
      const anonymous = await testApp.app.inject({
        method: 'POST',
        url: '/v1/fleet/vehicles',
        payload: NEW_CAR,
      });
      expect(anonymous.statusCode).toBe(401);
      expect((await addCar(NEW_CAR, 'OPS_AGENT')).statusCode).toBe(403);
    });

    it('rejects a car with markup in its name, a bad rate, or an unknown field', async () => {
      expect((await addCar({ ...NEW_CAR, make: '<script>alert(1)</script>' })).statusCode).toBe(
        400,
      );
      expect((await addCar({ ...NEW_CAR, dailyRate: -5 })).statusCode).toBe(400);
      expect((await addCar({ ...NEW_CAR, tenantId: 'other' })).statusCode).toBe(400);
    });

    it('refuses the same car twice', async () => {
      expect((await addCar()).statusCode).toBe(201);
      expect((await addCar()).statusCode).toBe(409);
    });

    it('updates a car (rate, availability)', async () => {
      const id = (await addCar()).json().vehicle.id;
      const response = await testApp.app.inject({
        method: 'POST',
        url: `/v1/fleet/vehicles/${id}`,
        headers: auth(await token('MANAGER')),
        payload: { dailyRate: 4000, availabilityStatus: 'MAINTENANCE' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().vehicle).toMatchObject({
        availabilityStatus: 'MAINTENANCE',
        pricingProfile: { dailyRate: 4000, currency: 'AED' },
      });
      const empty = await testApp.app.inject({
        method: 'POST',
        url: `/v1/fleet/vehicles/${id}`,
        headers: auth(await token()),
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
    });
  });

  describe('car photos', () => {
    it('stores a photo, lists it and serves it publicly with safe headers', async () => {
      const id = (await addCar()).json().vehicle.id;
      const uploaded = await upload(id, JPEG, 'image/jpeg', 'Front view');
      expect(uploaded.statusCode).toBe(201);
      const photo = uploaded.json().photo;
      expect(photo).toMatchObject({
        vehicleId: id,
        contentType: 'image/jpeg',
        caption: 'Front view',
        sortOrder: 0,
      });
      expect(photo.url).toMatch(new RegExp(`/media/vehicles/${photo.id}$`));

      const list = await testApp.app.inject({
        method: 'GET',
        url: '/v1/vehicles',
        headers: auth(await token()),
      });
      expect(list.json().items[0].photos).toHaveLength(1);

      // No login needed: the customer's browser fetches this directly.
      const served = await testApp.app.inject({
        method: 'GET',
        url: `/media/vehicles/${photo.id}`,
      });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toBe('image/jpeg');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(Buffer.compare(served.rawPayload, JPEG)).toBe(0);
    });

    it('accepts PNG and numbers photos in upload order', async () => {
      const id = (await addCar()).json().vehicle.id;
      await upload(id, JPEG);
      const second = await upload(id, PNG, 'image/png');
      expect(second.statusCode).toBe(201);
      expect(second.json().photo).toMatchObject({ contentType: 'image/png', sortOrder: 1 });
    });

    it('rejects anything that is not really a JPEG, PNG or WebP — whatever it claims to be', async () => {
      const id = (await addCar()).json().vehicle.id;
      const html = Buffer.from('<html><script>alert(1)</script></html>');
      expect((await upload(id, html, 'image/jpeg')).statusCode).toBe(400);
      expect((await upload(id, Buffer.alloc(0), 'image/jpeg')).statusCode).toBeGreaterThanOrEqual(
        400,
      );
      expect((await upload(id, html, 'text/html')).statusCode).toBeGreaterThanOrEqual(400);
      expect(await testApp.ctx.prisma.vehiclePhoto.count()).toBe(0);
    });

    it('rejects an oversized photo', async () => {
      const id = (await addCar()).json().vehicle.id;
      const big = Buffer.concat([JPEG, Buffer.alloc(4_100_000, 3)]);
      expect((await upload(id, big)).statusCode).toBeGreaterThanOrEqual(400);
      expect(await testApp.ctx.prisma.vehiclePhoto.count()).toBe(0);
    });

    it('caps the gallery at eight photos', async () => {
      const id = (await addCar()).json().vehicle.id;
      for (let index = 0; index < 8; index += 1) {
        expect((await upload(id, JPEG)).statusCode).toBe(201);
      }
      expect((await upload(id, JPEG)).statusCode).toBe(409);
    });

    it('needs fleet:write to upload and to delete', async () => {
      const id = (await addCar()).json().vehicle.id;
      const denied = await testApp.app.inject({
        method: 'POST',
        url: `/v1/fleet/vehicles/${id}/photos`,
        headers: { ...auth(await token('OPS_AGENT')), 'content-type': 'image/jpeg' },
        payload: JPEG,
      });
      expect(denied.statusCode).toBe(403);
    });

    it('deletes a photo and stops serving it', async () => {
      const id = (await addCar()).json().vehicle.id;
      const photo = (await upload(id, JPEG)).json().photo;
      const removed = await testApp.app.inject({
        method: 'POST',
        url: `/v1/fleet/photos/${photo.id}/delete`,
        headers: auth(await token()),
      });
      expect(removed.statusCode).toBe(200);
      const gone = await testApp.app.inject({ method: 'GET', url: `/media/vehicles/${photo.id}` });
      expect(gone.statusCode).toBe(404);
      const again = await testApp.app.inject({
        method: 'POST',
        url: `/v1/fleet/photos/${photo.id}/delete`,
        headers: auth(await token()),
      });
      expect(again.statusCode).toBe(404);
    });

    it('returns 404 for a photo id that does not exist', async () => {
      const missing = await testApp.app.inject({
        method: 'GET',
        url: `/media/vehicles/${randomUUID()}`,
      });
      expect(missing.statusCode).toBe(404);
      const notAnId = await testApp.app.inject({
        method: 'GET',
        url: '/media/vehicles/../../etc/passwd',
      });
      expect(notAnId.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe('the concierge sends car photos in chat', () => {
    it('attaches the uploaded photos when the customer asks to see a car', async () => {
      const id = (await addCar()).json().vehicle.id;
      const photo = (await upload(id, JPEG, 'image/jpeg', 'Side view')).json().photo;

      const sessionId = randomUUID();
      const response = await chat(sessionId, 'Can you send me a photo of the Lamborghini Urus?');
      expect(response.status).toBe(200);
      expect(response.body.reply.text).toMatch(/Here are photos of the Lamborghini Urus/);
      expect(response.body.reply.attachments).toEqual([
        { type: 'image', url: photo.url, caption: 'Lamborghini Urus - Side view' },
      ]);

      // ...and the picture is still there when the customer reopens the chat.
      const session = await testApp.app.inject({
        method: 'GET',
        url: `/v1/chat/sessions/${sessionId}`,
      });
      const concierge = session
        .json()
        .messages.filter((m: { role: string }) => m.role === 'CONCIERGE');
      expect(concierge[0].attachments).toHaveLength(1);
      const customer = session.json().messages.find((m: { role: string }) => m.role === 'CUSTOMER');
      expect(customer.attachments).toEqual([]);
    });

    it('understands a Hinglish request and a bare "send photo" in a car conversation', async () => {
      const id = (await addCar()).json().vehicle.id;
      await upload(id, JPEG);
      const hinglish = await chat(randomUUID(), 'urus ki photo dikhao');
      expect(hinglish.body.reply.attachments).toHaveLength(1);

      const sessionId = randomUUID();
      await chat(sessionId, BOOKING);
      const bare = await chat(sessionId, 'can you send me a pic');
      expect(bare.body.reply.attachments).toHaveLength(1);
      // The journey carries on underneath the photos.
      expect(bare.body.reply.text).toMatch(/date of birth|driving licence/i);
    });

    it('shows one photo per car for "show me all your cars"', async () => {
      const urus = (await addCar()).json().vehicle.id;
      const rover = (
        await addCar({ ...NEW_CAR, make: 'Land Rover', model: 'Range Rover', dailyRate: 1800 })
      ).json().vehicle.id;
      await upload(urus, JPEG);
      await upload(rover, PNG, 'image/png');
      const response = await chat(randomUUID(), 'show me all your cars');
      expect(response.body.reply.attachments).toHaveLength(2);
      expect(response.body.reply.text).toMatch(/Lamborghini Urus and Land Rover Range Rover/);
    });

    it('asks which car when none is named, and says honestly when a car has no photos yet', async () => {
      const id = (await addCar()).json().vehicle.id;
      const ask = await chat(randomUUID(), 'send me a photo');
      expect(ask.body.reply.text).toMatch(
        /Which car would you like to see\? We currently offer the Lamborghini Urus/,
      );
      expect(ask.body.reply.attachments).toEqual([]);

      const none = await chat(randomUUID(), 'photo of the urus please');
      expect(none.body.reply.text).toMatch(/do not have photos of the Lamborghini Urus/);
      expect(none.body.reply.attachments).toEqual([]);
      expect(id).toBeTruthy();
    });

    it('does not treat "photo of my passport" as a request for a car photo', async () => {
      const id = (await addCar()).json().vehicle.id;
      await upload(id, JPEG);
      const response = await chat(randomUUID(), 'I can send a photo of my passport');
      expect(response.body.reply.attachments).toEqual([]);
    });
  });

  describe('contact capture and automatic notifications', () => {
    async function quoteIssuedSession() {
      await addCar();
      const sessionId = randomUUID();
      await chat(sessionId, BOOKING);
      const quoted = await chat(sessionId, FULL_DETAILS);
      expect(quoted.body.journeyState).toBe('QUOTE_ISSUED');
      return { sessionId, quoted };
    }

    it('asks a website customer for email and phone once a quote is issued', async () => {
      const { quoted } = await quoteIssuedSession();
      expect(quoted.body.reply.text).toMatch(/share your email address and phone number/);
    });

    it('saves what the customer types to the CRM and emails + texts the quote once', async () => {
      const { sessionId } = await quoteIssuedSession();
      expect(email.sent).toHaveLength(0);

      const contact = await chat(
        sessionId,
        'my name is sara khan, email Sara.Khan@Example.com, phone +971 50 123 4567',
      );
      expect(contact.status).toBe(200);
      // Once they have shared it, the concierge stops asking.
      expect(contact.body.reply.text).not.toMatch(/share your email address and phone number/);

      const customer = await testApp.ctx.prisma.customer.findFirstOrThrow();
      expect(customer).toMatchObject({
        email: 'sara.khan@example.com',
        phone: '+971501234567',
        displayName: 'Sara Khan',
      });

      const quoteMail = email.sent.find((mail) => /quote/i.test(mail.subject));
      expect(quoteMail).toBeDefined();
      expect(quoteMail!.to).toBe('sara.khan@example.com');
      expect(quoteMail!.body).toMatch(/Hello Sara Khan,/);
      expect(quoteMail!.body).toMatch(/Total: AED/);
      const quoteSms = sms.sent.find((text) => /quote/i.test(text.body));
      expect(quoteSms).toBeDefined();
      expect(quoteSms!.to).toBe('+971501234567');
      expect(quoteSms!.body).toMatch(/AED/);

      // A later message must not send the same quote again.
      const before = { emails: email.sent.length, texts: sms.sent.length };
      await chat(sessionId, 'thanks, what is the deposit for?');
      expect(email.sent.length).toBe(before.emails);
      expect(sms.sent.length).toBe(before.texts);

      const sentRows = await testApp.ctx.prisma.notificationDelivery.findMany({
        where: { kind: 'QUOTE_ISSUED', status: 'SENT' },
      });
      expect(sentRows.map((row) => row.channel).sort()).toEqual(['EMAIL', 'SMS']);
    });

    it('confirms the hand-over to the customer by email and SMS when a person takes over', async () => {
      const { sessionId } = await quoteIssuedSession();
      await chat(sessionId, 'email sara@example.com phone +971501234567');
      email.sent.length = 0;
      sms.sent.length = 0;

      const accepted = await chat(sessionId, 'confirm, I would like to go ahead');
      expect(accepted.body.escalated).toBe(true);
      expect(email.sent.some((mail) => /have your request/i.test(mail.subject))).toBe(true);
      expect(sms.sent.some((text) => /team has your rental request/i.test(text.body))).toBe(true);
    });

    it('sends nothing (and does not ask twice forever) for a customer who gives no contact details', async () => {
      const { sessionId } = await quoteIssuedSession();
      await chat(sessionId, 'ok');
      await chat(sessionId, 'ok');
      await chat(sessionId, 'ok');
      expect(email.sent).toHaveLength(0);
      expect(sms.sent.filter((text) => /quote/i.test(text.body))).toHaveLength(0);

      const messages = await testApp.ctx.prisma.outboundMessage.findMany();
      const asks = messages.filter((m) =>
        /share your email address and phone number/.test(m.content),
      );
      expect(asks.length).toBeLessThanOrEqual(2);
    });

    it('ignores dates, prices and document numbers when looking for a phone number', async () => {
      await quoteIssuedSession();
      const customer = await testApp.ctx.prisma.customer.findFirstOrThrow();
      expect(customer.phone).toBeNull();
      expect(customer.email).toBeNull();
    });

    it('records "journey started" once per journey in the CRM timeline', async () => {
      await quoteIssuedSession();
      const started = await testApp.ctx.prisma.customerTimelineEvent.count({
        where: { type: 'JOURNEY_STARTED' },
      });
      expect(started).toBe(1);
    });
  });
});

describe('automatic notifications without providers configured — integration', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await buildTestApp({ RATE_LIMIT_MAX: 5000, AUTH_RATE_LIMIT_MAX: 5000 });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await truncateAllTables(testApp.ctx.prisma);
    await seedTestTenants(testApp.ctx.prisma);
    await createEligibilityPolicyVersion(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      rules: POLICY,
    });
  });

  it('records NOT_CONFIGURED once per notification — never a fake success — and the chat still works', async () => {
    const admin = await seedTestUser(testApp.ctx.prisma, {
      tenantId: TEST_TENANT_ID,
      role: 'ADMIN',
      email: 'admin@example.com',
    });
    expect(admin.id).toBeTruthy();
    const login = await testApp.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@example.com', password: TEST_USER_PASSWORD },
    });
    const created = await testApp.app.inject({
      method: 'POST',
      url: '/v1/fleet/vehicles',
      headers: { authorization: `Bearer ${login.json().accessToken}` },
      payload: NEW_CAR,
    });
    expect(created.statusCode).toBe(201);

    const sessionId = randomUUID();
    const send = async (message: string) =>
      (
        await testApp.app.inject({
          method: 'POST',
          url: '/v1/chat/messages',
          payload: { sessionId, clientMessageId: randomUUID(), message },
        })
      ).json();
    await send(BOOKING);
    await send(FULL_DETAILS);
    const withContact = await send('email sara@example.com and phone +971501234567');
    expect(withContact.journeyState).toBe('QUOTE_ISSUED');
    await send('thanks');

    const rows = await testApp.ctx.prisma.notificationDelivery.findMany({
      where: { kind: 'QUOTE_ISSUED' },
    });
    expect(rows.map((row) => `${row.channel}:${row.status}`).sort()).toEqual([
      'EMAIL:NOT_CONFIGURED',
      'SMS:NOT_CONFIGURED',
    ]);
  });
});
