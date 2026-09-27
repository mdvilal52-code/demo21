/**
 * Shared by every place that sends or resends a reply over the Email
 * channel (the inbound webhook's fallback, staff replies, and both the
 * manual and automatic resend paths) so a future copy change never has to
 * be made in more than one place.
 */
export const DEFAULT_REPLY_SUBJECT = 'Re: Your rental enquiry';
