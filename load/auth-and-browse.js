// k6 realistic mix: members sign in (rate-limit aware), then read their dashboard data.
// Needs pre-created load-test members (see docs/LOAD_TESTING.md). Run against staging, never production.
//   k6 run -e BASE_URL=https://staging.example.com -e USERS_FILE=load/users.json load/auth-and-browse.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const users = new SharedArray('users', () => JSON.parse(open(__ENV.USERS_FILE || './users.example.json')));

const loginOk = new Rate('login_ok');
const meMs = new Trend('me_ms', true);

export const options = {
  scenarios: {
    members: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '5m', target: 50 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    'http_req_duration{endpoint:me}': ['p(95)<300'],
    'http_req_duration{endpoint:introductions}': ['p(95)<600'],
    'http_req_duration{endpoint:login}': ['p(95)<1200'], // argon2id is deliberately slow
    login_ok: ['rate>0.99'],
  },
};

export default function () {
  const u = users[(__VU - 1) % users.length];
  const jar = http.cookieJar();
  const login = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email: u.email, password: u.password }), {
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    tags: { endpoint: 'login' },
  });
  const ok = check(login, { 'login 200': (r) => r.status === 200 });
  loginOk.add(ok);
  if (!ok) {
    sleep(5);
    return;
  }

  for (let i = 0; i < 5; i++) {
    const me = http.get(`${BASE}/api/v1/auth/me`, { tags: { endpoint: 'me' } });
    meMs.add(me.timings.duration);
    check(me, { 'me 200': (r) => r.status === 200 });
    const intros = http.get(`${BASE}/api/v1/introductions`, { tags: { endpoint: 'introductions' } });
    check(intros, { 'introductions 200': (r) => r.status === 200 });
    http.get(`${BASE}/api/v1/notifications/unread-count`, { tags: { endpoint: 'unread' } });
    sleep(Math.random() * 3 + 1);
  }
  jar.clear(BASE);
}
