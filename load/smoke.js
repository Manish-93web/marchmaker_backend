// k6 smoke test: a few virtual users hit the public, cacheable endpoints and the health checks.
// Run: k6 run -e BASE_URL=https://staging.example.com load/smoke.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';

export const options = {
  vus: 5,
  duration: '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<400'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const health = http.get(`${BASE}/healthz`);
  check(health, { 'health is 200': (r) => r.status === 200 });

  const plans = http.get(`${BASE}/api/v1/plans`);
  check(plans, {
    'plans is 200': (r) => r.status === 200,
    'plans has items': (r) => Array.isArray(r.json('items')) && r.json('items').length > 0,
  });

  const flags = http.get(`${BASE}/api/v1/flags`);
  check(flags, { 'flags is 200': (r) => r.status === 200 });
  sleep(1);
}
