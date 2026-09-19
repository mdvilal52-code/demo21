import { describe, expect, it } from 'vitest';
import { parseWhatsAppTextMessages } from './inboundParser.js';

function textPayload(overrides: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                { from: '971501234567', id: 'wamid.1', type: 'text', text: { body: 'hello' } },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

describe('parseWhatsAppTextMessages', () => {
  it('extracts a single text message', () => {
    const messages = parseWhatsAppTextMessages(textPayload());
    expect(messages).toEqual([{ messageId: 'wamid.1', from: '971501234567', body: 'hello' }]);
  });

  it('extracts multiple messages across entries/changes', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            { value: { messages: [{ from: 'a', id: 'm1', type: 'text', text: { body: 'x' } }] } },
          ],
        },
        {
          changes: [
            { value: { messages: [{ from: 'b', id: 'm2', type: 'text', text: { body: 'y' } }] } },
          ],
        },
      ],
    };
    expect(parseWhatsAppTextMessages(payload)).toHaveLength(2);
  });

  it('ignores delivery-status callbacks with no messages array', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }],
    };
    expect(parseWhatsAppTextMessages(payload)).toEqual([]);
  });

  it('ignores non-text message types (image, location, interactive, …)', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: '971501234567', id: 'wamid.2', type: 'image' },
                  { from: '971501234567', id: 'wamid.3', type: 'location' },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWhatsAppTextMessages(payload)).toEqual([]);
  });

  it('never throws on a malformed/unexpected payload shape', () => {
    expect(parseWhatsAppTextMessages(null)).toEqual([]);
    expect(parseWhatsAppTextMessages(undefined)).toEqual([]);
    expect(parseWhatsAppTextMessages('not an object')).toEqual([]);
    expect(parseWhatsAppTextMessages({})).toEqual([]);
    expect(parseWhatsAppTextMessages({ entry: 'not-an-array' })).toEqual([]);
  });

  it('never throws when a message claims type text but has no text body', () => {
    const payload = {
      entry: [{ changes: [{ value: { messages: [{ from: 'a', id: 'm1', type: 'text' }] } }] }],
    };
    expect(parseWhatsAppTextMessages(payload)).toEqual([]);
  });
});
