import { afterEach, describe, expect, it, vi } from 'vitest';
import { RazorpayProvider } from '../src/lib/payments';

afterEach(() => vi.unstubAllGlobals());

describe('Razorpay failures', () => {
  it('reach the member as a clear 502 that names the provider status, not a bare 500', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { description: 'Authentication failed' } }), { status: 401 }));
    const provider = new RazorpayProvider('rzp_test_wrong', 'wrong', 'whsec');
    await expect(provider.createPlan({ name: 'Premium (monthly)', amountPaise: 249900, interval: 'monthly' })).rejects.toMatchObject({
      status: 502,
      code: 'PAYMENT_PROVIDER_ERROR',
      details: { provider: 'razorpay', status: 401 },
    });
  });
});
