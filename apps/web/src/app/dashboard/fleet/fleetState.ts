export interface FleetFormState {
  status: 'idle' | 'success' | 'error';
  message: string;
  /** Bumped on every submit so the form can react to a repeated identical result. */
  nonce: number;
}

export const INITIAL_FLEET_FORM_STATE: FleetFormState = { status: 'idle', message: '', nonce: 0 };
