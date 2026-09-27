export interface ReplyState {
  status: 'idle' | 'sent' | 'not_delivered' | 'error';
  message: string;
  /** Changes on every submission so the form can react to a repeat of the same outcome. */
  nonce: number;
}

export const INITIAL_REPLY_STATE: ReplyState = { status: 'idle', message: '', nonce: 0 };
