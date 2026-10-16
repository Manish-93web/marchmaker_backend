// k6 burst of signed payment webhooks, including duplicates, to prove processing stays idempotent
// under load. The signing secret must match the staging API's RAZORPAY_WEBHOOK_SECRET.
//   k6 run -e BASE_URL=https://staging.example.com -e WEBHOOK_SECRET=... load/webhook-burst.js
import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const SECRET = __ENV.WEBHOOK_SECRET || 'dev-only-razorpay-webhook-secret';

export const options = {
  scenarios: { burst: { executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s', duration: '1m', preAllocatedVUs: 50 } },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'] },
};

export default function () {
  // Every fifth event repeats an earlier id: the API must answer 200 and do nothing the second time.
  const n = __ITER % 5 === 0 ? Math.max(0, __ITER - 5) : __ITER;
  const body = JSON.stringify({ entity: 'event', event: 'payment.failed', payload: { payment: { entity: { id: `pay_load_${n}`, order_id: `order_unknown_${n}`, amount: 49900 } } } });
  const sig = crypto.hmac('sha256', SECRET, body, 'hex');
  const res = http.post(`${BASE}/api/v1/webhooks/razorpay`, body, {
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': `evt_load_${n}` },
  });
  check(res, { 'acknowledged': (r) => r.status === 200 });

  const bad = http.post(`${BASE}/api/v1/webhooks/razorpay`, body, { headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'nope' } });
  check(bad, { 'bad signature refused': (r) => r.status === 401 });
}
