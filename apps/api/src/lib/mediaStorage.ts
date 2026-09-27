import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

const EXTENSIONS: Record<ImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Decides what an upload really is from its first bytes — never from the
 * file name or the Content-Type the client claimed (both are attacker
 * controlled). Anything that is not a JPEG, PNG or WebP is rejected, so an
 * HTML/SVG/script file can never be stored and later served as a "photo".
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function storageKeyFor(photoId: string, type: ImageType): string {
  return `${photoId}.${EXTENSIONS[type]}`;
}

const SAFE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/** Where photo bytes live. Behind an interface so object storage (S3, R2) can replace the disk later. */
export interface MediaStorage {
  save(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

/**
 * One flat directory of generated `<uuid>.<ext>` files. `key` is validated
 * against that exact shape before it ever touches the filesystem, so a
 * poisoned database row can not turn into a path traversal.
 */
export class DiskMediaStorage implements MediaStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathFor(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error('Invalid media storage key');
    return path.join(this.root, key);
  }

  async save(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(this.root, { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
