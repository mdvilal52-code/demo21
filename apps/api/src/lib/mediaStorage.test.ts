import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiskMediaStorage, sniffImageType, storageKeyFor } from './mediaStorage.js';

const ID = '3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f';

describe('sniffImageType', () => {
  it('recognises JPEG, PNG and WebP from their first bytes', () => {
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(
      sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
    ).toBe('image/png');
    expect(sniffImageType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
  });

  it('refuses everything else, including markup dressed up as an image', () => {
    expect(sniffImageType(Buffer.from('<html></html>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull();
  });
});

describe('DiskMediaStorage', () => {
  let root: string;
  let storage: DiskMediaStorage;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'media-test-'));
    storage = new DiskMediaStorage(path.join(root, 'nested'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('saves, reads and removes a photo', async () => {
    const key = storageKeyFor(ID, 'image/jpeg');
    expect(key).toBe(`${ID}.jpg`);
    await storage.save(key, Buffer.from([1, 2, 3]));
    expect([...(await storage.read(key))!]).toEqual([1, 2, 3]);
    await storage.remove(key);
    expect(await storage.read(key)).toBeNull();
    await storage.remove(key); // removing twice is harmless
  });

  it('never overwrites an existing file', async () => {
    const key = storageKeyFor('aaaaaaaa-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'image/png');
    await storage.save(key, Buffer.from([1]));
    await expect(storage.save(key, Buffer.from([2]))).rejects.toThrow();
    expect([...(await storage.read(key))!]).toEqual([1]);
  });

  it.each(['../../etc/passwd', '..\\secret.jpg', `${ID}.html`, `${ID}/../x.jpg`, '', 'a.jpg'])(
    'refuses the unsafe key %j',
    async (key) => {
      await expect(storage.read(key)).rejects.toThrow('Invalid media storage key');
      await expect(storage.save(key, Buffer.from([1]))).rejects.toThrow();
      await expect(storage.remove(key)).rejects.toThrow();
    },
  );

  it('writes only inside its own directory', async () => {
    const files = await readdir(root);
    expect(files).toEqual(['nested']);
  });
});
