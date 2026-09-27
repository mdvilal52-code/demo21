'use client';

import type { VehiclePhoto } from '@ai-concierge/contracts';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { deletePhotoAction } from '../../app/dashboard/fleet/actions';
import { shrinkImage } from '../../lib/imageResize';

const MAX_PHOTOS = 8;

/**
 * The car's gallery: what customers are shown when they ask the concierge to
 * see this car. Photos are shrunk in the browser, then uploaded one by one.
 */
export function VehiclePhotos({
  vehicleId,
  photos,
  canEdit,
}: {
  vehicleId: string;
  photos: VehiclePhoto[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, startRemoving] = useTransition();

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setMessage(null);
    let saved = 0;
    try {
      for (const file of Array.from(files)) {
        if (photos.length + saved >= MAX_PHOTOS) {
          throw new Error(`A car can have at most ${MAX_PHOTOS} photos.`);
        }
        const blob = await shrinkImage(file);
        const response = await fetch(`/api/fleet/vehicles/${vehicleId}/photos`, {
          method: 'POST',
          headers: { 'content-type': blob.type },
          body: blob,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? 'The photo could not be saved.');
        }
        saved += 1;
      }
      setMessage({ tone: 'ok', text: saved === 1 ? 'Photo added.' : `${saved} photos added.` });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'The photo could not be saved.',
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
      router.refresh();
    }
  }

  return (
    <div className="mt-4">
      <p className="text-[11px] uppercase tracking-wide text-ink-600">
        Photos ({photos.length}/{MAX_PHOTOS})
      </p>
      {photos.length === 0 && (
        <p className="mt-1 text-xs text-ink-600">
          No photos yet. The concierge cannot show this car until you add one.
        </p>
      )}
      <ul className="mt-2 grid grid-cols-3 gap-2">
        {photos.map((photo) => (
          <li key={photo.id} className="relative">
            {/* Plain <img>: the photo is served by the API, not from this app. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.url}
              alt={photo.caption ?? 'Car photo'}
              loading="lazy"
              className="aspect-[4/3] w-full rounded-lg object-cover"
            />
            {canEdit && (
              <button
                type="button"
                disabled={removing}
                aria-label="Remove this photo"
                onClick={() => startRemoving(() => deletePhotoAction(photo.id))}
                className="absolute right-1 top-1 rounded-full bg-ink-900/80 px-2 text-xs text-cream-50 hover:bg-danger"
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && photos.length < MAX_PHOTOS && (
        <div className="mt-3">
          <label className="inline-flex cursor-pointer items-center rounded-pill border border-ink-900/40 px-4 py-2 text-xs font-medium text-ink-900 hover:bg-ink-900/10">
            {uploading ? 'Uploading…' : 'Add photos'}
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={uploading}
              onChange={(event) => void upload(event.target.files)}
              className="sr-only"
              data-testid="photo-input"
            />
          </label>
        </div>
      )}
      {message && (
        <p
          role="status"
          className={`mt-2 text-xs ${message.tone === 'ok' ? 'text-success' : 'text-danger'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
