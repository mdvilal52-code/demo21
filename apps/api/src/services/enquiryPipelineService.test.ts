import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOpenConversationForCustomer: vi.fn(),
  submitEnquiry: vi.fn(),
  continueEnquiry: vi.fn(),
  extractDatesAndLocation: vi.fn(),
  determineVehicle: vi.fn(),
  checkMissingInfo: vi.fn(),
}));

vi.mock('@ai-concierge/db', () => ({
  findOpenConversationForCustomer: mocks.findOpenConversationForCustomer,
}));
vi.mock('./enquiryService.js', () => ({
  submitEnquiry: mocks.submitEnquiry,
  continueEnquiry: mocks.continueEnquiry,
}));
vi.mock('./dateLocationService.js', () => ({
  extractDatesAndLocation: mocks.extractDatesAndLocation,
}));
vi.mock('./vehicleService.js', () => ({ determineVehicle: mocks.determineVehicle }));
vi.mock('./missingInfoService.js', () => ({ checkMissingInfo: mocks.checkMissingInfo }));

const { runFullEnquiryPipeline } = await import('./enquiryPipelineService.js');

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function makeDeps() {
  return {
    prisma: {},
    intentEngine: {},
    postEnquiryQueue: {},
    dateLocationOrchestrator: {},
    vehicleOrchestrator: {},
    missingInfoOrchestrator: {},
  } as never;
}

describe('runFullEnquiryPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOpenConversationForCustomer.mockResolvedValue(null);
    mocks.submitEnquiry.mockResolvedValue({ conversationId: 'conv-1', messageId: 'msg-1' });
    mocks.continueEnquiry.mockResolvedValue({ conversationId: 'conv-1', messageId: 'msg-2' });
    mocks.extractDatesAndLocation.mockResolvedValue({});
    mocks.determineVehicle.mockResolvedValue({});
    mocks.checkMissingInfo.mockResolvedValue({});
  });

  it('starts a fresh conversation when the customer has no open one', async () => {
    await runFullEnquiryPipeline(makeDeps(), {
      tenantId: TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971501234567',
      message: 'I want a car',
      requestId: 'req-1',
    });

    expect(mocks.findOpenConversationForCustomer).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      'WHATSAPP',
      '971501234567',
    );
    expect(mocks.submitEnquiry).toHaveBeenCalled();
    expect(mocks.continueEnquiry).not.toHaveBeenCalled();
    expect(mocks.extractDatesAndLocation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
  });

  it("continues the customer's open conversation instead of starting a new one", async () => {
    mocks.findOpenConversationForCustomer.mockResolvedValue({ id: 'conv-1' });

    await runFullEnquiryPipeline(makeDeps(), {
      tenantId: TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971501234567',
      message: '15 to 19 Oct',
      requestId: 'req-1',
    });

    expect(mocks.continueEnquiry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT_ID,
        conversationId: 'conv-1',
        channel: 'WHATSAPP',
        message: '15 to 19 Oct',
      }),
    );
    expect(mocks.submitEnquiry).not.toHaveBeenCalled();
    expect(mocks.determineVehicle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
    expect(mocks.checkMissingInfo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
  });

  it('returns the combined result of all four steps', async () => {
    mocks.extractDatesAndLocation.mockResolvedValue({ extraction: 'dates' });
    mocks.determineVehicle.mockResolvedValue({ determination: 'vehicle' });
    mocks.checkMissingInfo.mockResolvedValue({ missingInfo: 'info' });

    const result = await runFullEnquiryPipeline(makeDeps(), {
      tenantId: TENANT_ID,
      channel: 'WHATSAPP',
      customerRef: '971501234567',
      message: 'I want a car',
      requestId: 'req-1',
    });

    expect(result).toEqual({
      enquiry: { conversationId: 'conv-1', messageId: 'msg-1' },
      dateLocation: { extraction: 'dates' },
      vehicle: { determination: 'vehicle' },
      missingInfo: { missingInfo: 'info' },
    });
  });
});
