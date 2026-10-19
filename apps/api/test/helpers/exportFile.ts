import { strFromU8, unzipSync } from 'fflate';
import type { ObjectStorage } from '../../src/lib/storage';

/** The finished data export for a request, read back from the documents bucket: the parsed data.json inside the zip. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readExport(storage: ObjectStorage, requestId: string): Promise<Record<string, any>> {
  const zip = unzipSync(new Uint8Array(await storage.get('documents', `exports/${requestId}.zip`)));
  return JSON.parse(strFromU8(zip['data.json']!));
}
