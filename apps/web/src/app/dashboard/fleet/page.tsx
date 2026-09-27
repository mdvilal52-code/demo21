import { redirect } from 'next/navigation';
import { Permission } from '@ai-concierge/domain';
import { fetchVehicles, SessionExpiredError } from '../../../lib/adminApi';
import { getCurrentUser } from '../../../lib/getCurrentUser';
import { hasPermission } from '../../../lib/dashboardNav';
import { AddVehicleForm } from '../../../components/dashboard/AddVehicleForm';
import { VehicleEditForm } from '../../../components/dashboard/VehicleEditForm';
import { VehiclePhotos } from '../../../components/dashboard/VehiclePhotos';
import { CopperCard } from '../../../components/ui/CopperCard';
import { GlassCard } from '../../../components/ui/GlassCard';
import { StatusChip } from '../../../components/ui/StatusChip';
import { formatEnumLabel } from '../../../lib/format';

export default async function FleetPage() {
  let items;
  try {
    const result = await fetchVehicles({ limit: 100, offset: 0 });
    items = result.items;
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect('/login');
    throw error;
  }
  const user = await getCurrentUser();
  const canEdit = user !== null && hasPermission(user.role, Permission.FLEET_WRITE);

  return (
    <div className="mx-auto max-w-4xl py-8">
      <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">Fleet</h1>
      <p className="mt-2 text-sm text-cream-50/70">
        Your cars, their daily rates and photos. When a customer asks the concierge to see a car, it
        sends these photos automatically.
      </p>

      {canEdit ? (
        <GlassCard className="mt-6">
          <h2 className="font-display text-sm uppercase tracking-wide text-cream-50">Add a car</h2>
          <div className="mt-4">
            <AddVehicleForm />
          </div>
        </GlassCard>
      ) : (
        <p className="mt-4 text-xs text-cream-50/60">
          Only an admin or a manager can add cars and photos.
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {items.length === 0 && (
          <GlassCard className="sm:col-span-2">
            <p className="text-sm text-cream-50/70">No vehicles in the catalog yet.</p>
          </GlassCard>
        )}

        {items.map((vehicle) => (
          <CopperCard key={vehicle.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-display text-sm uppercase tracking-wide text-ink-900">
                  {vehicle.make} {vehicle.model}
                </h2>
                <p className="mt-1 text-xs text-ink-600">
                  {formatEnumLabel(vehicle.category)} · {formatEnumLabel(vehicle.luxuryTier)}
                </p>
              </div>
              {!vehicle.active && <StatusChip tone="neutral">Inactive</StatusChip>}
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-ink-600">
              <div>
                <dt className="uppercase tracking-wide">Seats</dt>
                <dd className="mt-0.5 text-ink-900">{vehicle.seats}</dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide">Luggage</dt>
                <dd className="mt-0.5 text-ink-900">{vehicle.luggage}</dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide">Transmission</dt>
                <dd className="mt-0.5 text-ink-900">{formatEnumLabel(vehicle.transmission)}</dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide">Availability</dt>
                <dd className="mt-0.5 text-ink-900">
                  {formatEnumLabel(vehicle.availabilityStatus)}
                </dd>
              </div>
            </dl>

            <p className="mt-4 text-sm font-medium text-ink-900">
              {vehicle.pricingProfile.currency} {vehicle.pricingProfile.dailyRate.toLocaleString()}{' '}
              / day
            </p>

            <VehiclePhotos vehicleId={vehicle.id} photos={vehicle.photos} canEdit={canEdit} />
            {canEdit && <VehicleEditForm vehicle={vehicle} />}
          </CopperCard>
        ))}
      </div>
    </div>
  );
}
