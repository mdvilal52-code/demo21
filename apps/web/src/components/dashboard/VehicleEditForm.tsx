'use client';

import type { FleetVehicle } from '@ai-concierge/contracts';
import { useActionState } from 'react';
import { updateVehicleAction } from '../../app/dashboard/fleet/actions';
import { INITIAL_FLEET_FORM_STATE } from '../../app/dashboard/fleet/fleetState';

const FIELD =
  'w-full rounded-lg border border-ink-900/20 bg-white/40 px-2 py-1 text-sm text-ink-900 focus:border-ink-900 focus:outline-none';

/** Rate, availability and on/off switch for one car. */
export function VehicleEditForm({ vehicle }: { vehicle: FleetVehicle }) {
  const [state, formAction, pending] = useActionState(
    updateVehicleAction.bind(null, vehicle.id),
    INITIAL_FLEET_FORM_STATE,
  );
  return (
    <form action={formAction} className="mt-4 grid grid-cols-2 gap-2 text-xs text-ink-600">
      <label className="col-span-1">
        <span className="uppercase tracking-wide">Rate / day (AED)</span>
        <input
          name="dailyRate"
          type="number"
          min={1}
          step="any"
          required
          defaultValue={vehicle.pricingProfile.dailyRate}
          className={FIELD}
        />
      </label>
      <label className="col-span-1">
        <span className="uppercase tracking-wide">Availability</span>
        <select
          name="availabilityStatus"
          defaultValue={vehicle.availabilityStatus}
          className={FIELD}
        >
          <option value="AVAILABLE">Available</option>
          <option value="MAINTENANCE">Maintenance</option>
          <option value="UNAVAILABLE">Unavailable</option>
        </select>
      </label>
      <label className="col-span-1 flex items-center gap-2">
        <input name="active" type="checkbox" defaultChecked={vehicle.active} />
        <span>Offered to customers</span>
      </label>
      <div className="col-span-1 flex items-center justify-end gap-2">
        {state.status !== 'idle' && (
          <span
            className={state.status === 'success' ? 'text-success' : 'text-danger'}
            role="status"
          >
            {state.message}
          </span>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-pill border border-ink-900/40 px-3 py-1 font-medium text-ink-900 hover:bg-ink-900/10 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
