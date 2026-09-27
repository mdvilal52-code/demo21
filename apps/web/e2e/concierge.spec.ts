import { expect, test } from '@playwright/test';

// A chat turn runs the whole automatic Steps 1-8 chain, so allow real time for it.
const TURN_MS = 60_000;

test.describe('Customer app (/concierge)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('home offers the app tabs and never pretends documents can be uploaded', async ({
    page,
  }) => {
    await page.goto('/concierge');

    for (const tab of ['Home', 'Chat', 'Requests', 'Profile']) {
      await expect(page.getByRole('link', { name: tab, exact: true })).toBeVisible();
    }
    await expect(page.getByText(/not available yet/i).first()).toBeVisible();
  });

  test('chat: a booking message gets a concierge reply and shows the journey progress', async ({
    page,
  }) => {
    await page.goto('/concierge/chat');
    await expect(page.locator('#chat-input')).toBeVisible();

    await page
      .locator('#chat-input')
      .fill(
        'I would like to rent a Lamborghini Urus from 15 October to 19 October, pickup Dubai Marina',
      );
    await page.getByRole('button', { name: 'Send' }).click();

    // The e2e database has no fleet, so the concierge asks which vehicle; with a fleet it asks for
    // the driver's date of birth. Either way it must answer, never leave the message hanging.
    await expect(page.getByText(/which vehicle|date of birth/i).first()).toBeVisible({
      timeout: TURN_MS,
    });
    await expect(page.locator('[data-testid="chat-step"]')).toBeVisible();
  });

  test('chat: the visitor keeps the conversation after a reload', async ({ page }) => {
    await page.goto('/concierge/chat');
    await page.locator('#chat-input').fill('Hello, I need a car in Dubai');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Hello, I need a car in Dubai')).toBeVisible();
    await expect(page.getByText('Sending…')).toHaveCount(0, { timeout: TURN_MS });

    await page.reload();
    await expect(page.getByText('Hello, I need a car in Dubai')).toBeVisible();
  });

  test('the offline page renders on its own', async ({ page }) => {
    await page.goto('/offline');
    await expect(page.getByRole('heading', { name: /You are offline/i })).toBeVisible();
  });

  test('the manifest is installable', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.ok()).toBe(true);
    const manifest = (await response.json()) as {
      display: string;
      start_url: string;
      icons: { src: string }[];
    };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/concierge');
    for (const icon of manifest.icons) {
      expect((await request.get(icon.src)).ok()).toBe(true);
    }
  });
});

test.describe('Staff dashboard', () => {
  test('signed-out visitors are sent to the sign-in page', async ({ page }) => {
    await page.goto('/dashboard/journeys');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });
});
