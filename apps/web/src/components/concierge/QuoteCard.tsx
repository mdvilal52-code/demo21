import type { ChatQuote } from '@ai-concierge/contracts';
import { formatDateTime, formatMoney } from '../../lib/format';
import { CopperCard } from '../ui/CopperCard';

/**
 * The customer's quote: every price line, the total and the deposit — the same
 * figures the pricing engine produced, never re-derived here. Nothing on this
 * card is a payment request; paying is arranged by the team after confirming.
 */
export function QuoteCard({ quote }: { quote: ChatQuote }) {
  const rows = [
    ...quote.lineItems.map((item) => ({
      key: `i-${item.description}`,
      label:
        item.quantity > 1
          ? `${item.description} · ${item.quantity} × ${formatMoney(item.unitAmount.minorUnits, item.unitAmount.currency)}`
          : item.description,
      amount: formatMoney(item.amount.minorUnits, item.amount.currency),
    })),
    ...quote.fees.map((fee) => ({
      key: `f-${fee.description}`,
      label: fee.description,
      amount: formatMoney(fee.amount.minorUnits, fee.amount.currency),
    })),
    ...quote.taxes.map((tax) => ({
      key: `t-${tax.description}`,
      label: tax.description,
      amount: formatMoney(tax.amount.minorUnits, tax.amount.currency),
    })),
    ...quote.discounts.map((discount) => ({
      key: `d-${discount.description}`,
      label: discount.description,
      amount: `-${formatMoney(discount.amount.minorUnits, discount.amount.currency)}`,
    })),
  ];

  return (
    <CopperCard className="text-ink-900" data-testid="quote-card">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-900/70">Your quote</p>
      <dl className="mt-3 space-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.key} className="flex justify-between gap-3">
            <dt className="text-ink-900/80">{row.label}</dt>
            <dd className="text-right tabular-nums">{row.amount}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-ink-900/20 pt-2 text-base font-semibold">
          <dt>Total</dt>
          <dd className="tabular-nums" data-testid="quote-card-total">
            {formatMoney(quote.total.minorUnits, quote.total.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-3 text-ink-900/80">
          <dt>Security deposit</dt>
          <dd className="tabular-nums">
            {formatMoney(quote.deposit.minorUnits, quote.deposit.currency)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-ink-900/70">
        Valid until {formatDateTime(quote.validUntil)} (Dubai time). Your eligibility is based on
        the details you gave us; our team verifies your documents before handover.
      </p>
    </CopperCard>
  );
}
