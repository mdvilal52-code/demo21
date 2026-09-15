import { expect, test } from '@playwright/test';

test.describe('Enquiry form — golden path', () => {
  test('submits a booking-shaped message and shows the recognized intent', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'AI Concierge' })).toBeVisible();

    const textarea = page.getByLabel('Your message');
    await textarea.fill('I want to rent a Lamborghini in Dubai Marina from 15 to 19 October');
    await page.getByRole('button', { name: 'Contact AI' }).click();

    await expect(page.getByText('BOOKING REQUEST')).toBeVisible();
    // Exact match: the textarea's own value also contains "Lamborghini" as a
    // substring, so a loose match resolves to two elements.
    await expect(page.getByText('lamborghini', { exact: true })).toBeVisible();
  });

  test('shows a clarification message when required booking details are missing', async ({
    page,
  }) => {
    await page.goto('/');

    const textarea = page.getByLabel('Your message');
    await textarea.fill('I want to rent a Lamborghini');
    await page.getByRole('button', { name: 'Contact AI' }).click();

    await expect(page.getByText('Needs info')).toBeVisible();
  });

  test('shows a validation message for an empty submission without calling the API', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Contact AI' }).click();
    await expect(page.getByText('Please tell us what you need before sending.')).toBeVisible();
  });
});
