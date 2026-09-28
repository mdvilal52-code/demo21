import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { EligibilityPolicyRules } from '@ai-concierge/domain';
import {
  createEligibilityPolicyVersion,
  createVehicle,
  createVehicleUnit,
} from '@ai-concierge/db';
import {
  createTestPrismaClient,
  seedTestUser,
  TEST_TENANT_ID,
  TEST_USER_PASSWORD,
} from '@ai-concierge/testing';

/**
 * Phase 16 added no web UI of its own (see docs/PHASE-16.md §8: "no
 * web/UI change"), but it does change what the *existing* Admin Dashboard
 * (Phase 12) renders: journeys the automatic Steps 5-8 chain now drives all
 * the way to a quote by itself, and escalation cases the autopilot's
 * human-hand-off rules create. This spec drives that chain the way a real
 * customer would — a signed WhatsApp webhook request, no step endpoint
 * called directly — then proves a staff member can see the result in the
 * dashboard. It fills the "Playwright e2e" gap docs/PHASE-16.md left open.
 */
const API_PORT = 4100;
const WHATSAPP_APP_SECRET = 'e2e-whatsapp-app-secret-0123456789';

const DEFAULT_POLICY: EligibilityPolicyRules = {
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

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WHATSAPP_APP_SECRET).update(body, 'utf8').digest('hex')}`;
}

function metaTextPayload(messageId: string, from: string, text: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '1234567890' },
              messages: [{ from, id: messageId, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

let seq = 0;

/** One inbound WhatsApp message through the real, signed webhook — never a step endpoint. */
async function sendWhatsAppMessage(from: string, text: string): Promise<void> {
  seq += 1;
  const body = metaTextPayload(`wamid.E2E-${seq}`, from, text);
  const response = await fetch(`http://localhost:${API_PORT}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    body,
  });
  if (!response.ok) {
    throw new Error(`WhatsApp webhook returned ${response.status}: ${await response.text()}`);
  }
}

test.describe('Dashboard — Phase 16 automatic journey (Steps 5-8)', () => {
  const staffEmail = 'e2e-dashboard@example.com';

  // Idempotent by design, not just by luck: `beforeAll` scope in Playwright
  // is per worker process, and this suite's `webServer`s are shared across
  // the whole run — a retry, a `--repeat-each`, or running this file
  // alongside others must never fail on "already exists".
  test.beforeAll(async () => {
    const prisma = createTestPrismaClient();
    try {
      let urus = await prisma.vehicle.findFirst({
        where: { tenantId: TEST_TENANT_ID, make: 'Lamborghini', model: 'Urus' },
      });
      if (!urus) {
        urus = await createVehicle(prisma, {
          tenantId: TEST_TENANT_ID,
          make: 'Lamborghini',
          model: 'Urus',
          color: 'Black',
          category: 'SUV',
          luxuryTier: 'ULTRA_LUXURY',
          seats: 5,
          luggage: 4,
          transmission: 'AUTOMATIC',
          pricingProfile: { currency: 'AED', dailyRate: 3500 },
        });
      }
      for (const unitRef of ['E2E-URUS-1', 'E2E-URUS-2']) {
        const existingUnit = await prisma.vehicleUnit.findFirst({
          where: { tenantId: TEST_TENANT_ID, vehicleId: urus.id, unitRef },
        });
        if (!existingUnit) {
          await createVehicleUnit(prisma, { tenantId: TEST_TENANT_ID, vehicleId: urus.id, unitRef });
        }
      }
      const existingPolicy = await prisma.eligibilityPolicy.findFirst({
        where: { tenantId: TEST_TENANT_ID, active: true },
      });
      if (!existingPolicy) {
        await createEligibilityPolicyVersion(prisma, {
          tenantId: TEST_TENANT_ID,
          rules: DEFAULT_POLICY,
        });
      }
      const existingUser = await prisma.user.findFirst({
        where: { tenantId: TEST_TENANT_ID, email: staffEmail },
      });
      if (!existingUser) {
        await seedTestUser(prisma, { tenantId: TEST_TENANT_ID, email: staffEmail, role: 'ADMIN' });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  async function signIn(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/login');
    await page.getByLabel('Email').fill(staffEmail);
    await page.getByLabel('Password').fill(TEST_USER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  }

  async function conversationIdFor(customerRef: string): Promise<string> {
    const prisma = createTestPrismaClient();
    try {
      const conversation = await prisma.conversation.findFirst({
        where: { tenantId: TEST_TENANT_ID, channel: 'WHATSAPP', customerRef },
        orderBy: { createdAt: 'desc' },
      });
      if (!conversation) throw new Error(`No conversation found for ${customerRef}`);
      return conversation.id;
    } finally {
      await prisma.$disconnect();
    }
  }

  test('a customer message chain reaches an issued quote automatically, and the dashboard shows it', async ({
    page,
  }) => {
    const customer = '971501119001';
    await sendWhatsAppMessage(
      customer,
      'Hi, I would like to rent a Lamborghini Urus from 15 October to 19 October, pickup Dubai Marina',
    );
    await sendWhatsAppMessage(
      customer,
      "I'm Indian, born 12 May 1990, I hold a UAE driving licence and I can provide my passport",
    );

    const conversationId = await conversationIdFor(customer);

    await signIn(page);
    await page.goto(`/dashboard/journeys/${conversationId}`);

    // Current-state status chip: exactly one, at the top of the page.
    await expect(page.getByText('Quote issued').first()).toBeVisible();
    // The chain's real hops in the transition timeline below it, not just
    // the final state — proves Steps 6 and 8 actually ran automatically
    // rather than the journey being force-set.
    // exact: true — the "from" half of each row renders as "<State> →",
    // which would otherwise also match a loose substring search.
    const timeline = page.getByRole('list');
    await expect(timeline.getByText('Availability check', { exact: true })).toBeVisible();
    await expect(timeline.getByText('Eligibility check', { exact: true })).toBeVisible();
  });

  test('a customer asking for a person creates an escalation the dashboard shows', async ({
    page,
  }) => {
    const customer = '971501119002';
    await sendWhatsAppMessage(
      customer,
      'Hi, I would like to rent a Lamborghini Urus from 15 October to 19 October, pickup Dubai Marina',
    );
    await sendWhatsAppMessage(customer, 'Actually I want to speak to a human agent please');

    await signIn(page);
    await page.goto('/dashboard/escalations');

    await expect(page.getByText('Escalation queue')).toBeVisible();
    // .first(): the fixed detail text journeyAutopilotService.ts emits for
    // this trigger, so a retry or a future sibling test producing the same
    // detail text can never turn this into a strict-mode failure.
    await expect(page.getByText('Customer asked to speak with a person').first()).toBeVisible();
  });
});
