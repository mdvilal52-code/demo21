'use client';

import { PillButton } from '../../components/ui/PillButton';

export function ReloadButton() {
  return <PillButton onClick={() => window.location.assign('/concierge')}>Try again</PillButton>;
}
