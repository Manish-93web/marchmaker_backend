import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { notificationMatrix } from '../src/scripts/notificationMatrix';

describe('generated docs', () => {
  it('keeps the notification matrix in docs/NOTIFICATIONS.md in step with the catalog', () => {
    const doc = readFileSync(path.resolve(__dirname, '../../../docs/NOTIFICATIONS.md'), 'utf8').replace(/
/g, '
');
    const block = doc.split('<!-- matrix:start -->')[1]!.split('<!-- matrix:end -->')[0]!.trim();
    expect(block, 'run: pnpm --filter @marchmaker/api docs:notifications').toBe(notificationMatrix());
  });
});
