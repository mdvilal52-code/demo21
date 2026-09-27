'use client';

import { useActionState, useEffect, useRef } from 'react';
import { createVehicleAction } from '../../app/dashboard/fleet/actions';
import {
  INITIAL_FLEET_FORM_STATE,
  type FleetFormState,
} from '../../app/dashboard/fleet/fleetState';
import { PillButton } from '../ui/PillButton';

const CATEGORIES = ['SEDAN', 'SUV', 'COUPE', 'CONVERTIBLE', 'SPORTS', 'VAN'] as const;
const TIERS = ['PREMIUM', 'LUXURY', 'ULTRA_LUXURY'] as const;

const TONE: Record<FleetFormState['status'], string> = {
  idle: '',
  success: 'text-success',
  error: 'text-danger',
};

const FIELD =
  'w-full rounded-xl border border-white/10 bg-emerald-900/60 px-3 py-2 text-sm text-cream-50 placeholder:text-cream-50/40 focus:border-copper-300 focus:outline-none';
const LABEL = 'block text-[11px] uppercase tracking-wide text-cream-50/70';

function label(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

/** "Add a car": name, specs, daily rate and how many of it you own. Photos are added after. */
export function AddVehicleForm() {
  const [state, formAction, pending] = useActionState(
    createVehicleAction,
    INITIAL_FLEET_FORM_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'success') formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      aria-label="Add a car"
    >
      <div className="col-span-2">
        <label htmlFor="make" className={LABEL}>
          Brand
        </label>
        <input
          id="make"
          name="make"
          required
          maxLength={60}
          placeholder="Toyota"
          className={FIELD}
        />
      </div>
      <div className="col-span-2">
        <label htmlFor="model" className={LABEL}>
          Model
        </label>
        <input
          id="model"
          name="model"
          required
          maxLength={60}
          placeholder="Camry"
          className={FIELD}
        />
      </div>
      <div>
        <label htmlFor="category" className={LABEL}>
          Type
        </label>
        <select id="category" name="category" defaultValue="SEDAN" className={FIELD}>
          {CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="luxuryTier" className={LABEL}>
          Class
        </label>
        <select id="luxuryTier" name="luxuryTier" defaultValue="PREMIUM" className={FIELD}>
          {TIERS.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="transmission" className={LABEL}>
          Gearbox
        </label>
        <select id="transmission" name="transmission" defaultValue="AUTOMATIC" className={FIELD}>
          <option value="AUTOMATIC">Automatic</option>
          <option value="MANUAL">Manual</option>
        </select>
      </div>
      <div>
        <label htmlFor="units" className={LABEL}>
          How many cars
        </label>
        <input
          id="units"
          name="units"
          type="number"
          min={1}
          max={50}
          defaultValue={1}
          required
          className={FIELD}
        />
      </div>
      <div>
        <label htmlFor="seats" className={LABEL}>
          Seats
        </label>
        <input
          id="seats"
          name="seats"
          type="number"
          min={1}
          max={20}
          defaultValue={5}
          required
          className={FIELD}
        />
      </div>
      <div>
        <label htmlFor="luggage" className={LABEL}>
          Bags
        </label>
        <input
          id="luggage"
          name="luggage"
          type="number"
          min={0}
          max={20}
          defaultValue={2}
          required
          className={FIELD}
        />
      </div>
      <div>
        <label htmlFor="dailyRate" className={LABEL}>
          Rate per day (AED)
        </label>
        <input
          id="dailyRate"
          name="dailyRate"
          type="number"
          min={1}
          step="any"
          required
          placeholder="500"
          className={FIELD}
        />
      </div>
      <div>
        <label htmlFor="depositAmount" className={LABEL}>
          Deposit (AED)
        </label>
        <input
          id="depositAmount"
          name="depositAmount"
          type="number"
          min={0}
          step="any"
          placeholder="optional"
          className={FIELD}
        />
      </div>
      <div className="col-span-2 flex flex-wrap items-center gap-3 sm:col-span-4">
        <PillButton type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add car'}
        </PillButton>
        {state.status !== 'idle' && (
          <p
            className={`text-sm ${TONE[state.status]}`}
            role="status"
            data-testid="fleet-form-status"
          >
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
