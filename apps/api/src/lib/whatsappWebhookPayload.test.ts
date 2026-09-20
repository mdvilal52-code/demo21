import { describe, expect, it } from 'vitest';
import { extractInboundMessages, whatsappWebhookPayloadSchema } from './whatsappWebhookPayload.js';

function textMessagePayload(overrides: Partial<{ from: string; id: string; body: string }> = {}) {
  return {
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
              contacts: [{ profile: { name: 'Jane' }, wa_id: overrides.from ?? '971501234567' }],
              messages: [
                {
                  from: overrides.from ?? '971501234567',
                  id: overrides.id ?? 'wamid.ABC123',
                  timestamp: '1710000000',
                  type: 'text',
                  text: { body: overrides.body ?? 'I want to rent a car' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('whatsappWebhookPayloadSchema', () => {
  it('accepts a real-shaped Meta text message payload', () => {
    const result = whatsappWebhookPayloadSchema.safeParse(textMessagePayload());
    expect(result.success).toBe(true);
  });

  it('accepts a status-only payload (delivery receipts, no messages)', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                statuses: [{ id: 'wamid.X', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    expect(whatsappWebhookPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('accepts an empty/unknown payload shape rather than crashing', () => {
    expect(whatsappWebhookPayloadSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a payload where entry is not an array', () => {
    expect(whatsappWebhookPayloadSchema.safeParse({ entry: 'not-an-array' }).success).toBe(false);
  });

  it('rejects a message missing required fields', () => {
    const payload = {
      entry: [{ changes: [{ value: { messages: [{ from: '123' }] } }] }],
    };
    expect(whatsappWebhookPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe('extractInboundMessages', () => {
  it('extracts a text message with its sender, id, and body', () => {
    const parsed = whatsappWebhookPayloadSchema.parse(textMessagePayload());
    const messages = extractInboundMessages(parsed);
    expect(messages).toEqual([
      { from: '971501234567', id: 'wamid.ABC123', type: 'text', text: 'I want to rent a car' },
    ]);
  });

  it('returns an empty array for a status-only payload', () => {
    const parsed = whatsappWebhookPayloadSchema.parse({
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X' }] } }] }],
    });
    expect(extractInboundMessages(parsed)).toEqual([]);
  });

  it('returns null text for a non-text message type', () => {
    const payload = textMessagePayload();
    // @ts-expect-error test payload manipulation
    payload.entry[0].changes[0].value.messages[0].type = 'image';
    const parsed = whatsappWebhookPayloadSchema.parse(payload);
    expect(extractInboundMessages(parsed)).toEqual([
      { from: '971501234567', id: 'wamid.ABC123', type: 'image', text: null },
    ]);
  });

  it('flattens messages across multiple entries and changes', () => {
    const a = textMessagePayload({ from: '111', id: 'wamid.A' });
    const b = textMessagePayload({ from: '222', id: 'wamid.B' });
    const merged = { entry: [...a.entry, ...b.entry] };
    const parsed = whatsappWebhookPayloadSchema.parse(merged);
    expect(extractInboundMessages(parsed).map((m) => m.id)).toEqual(['wamid.A', 'wamid.B']);
  });
});
