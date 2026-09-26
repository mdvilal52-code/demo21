import type { QuoteSnapshot } from '@ai-concierge/domain';
import { formatDateTime, formatMoney } from '../../lib/format';
import { StatusChip } from '../ui/StatusChip';

/** The current quote, line by line — what staff need to answer "what am I paying for?". */
export function QuotePanel({ quote }: { quote: QuoteSnapshot }) {
  const lines = [
    ...quote.lineItems.map((item) => ({
      key: `i-${item.code}`,
      label:
        item.quantity > 1
          ? `${item.description} (${item.quantity} × ${formatMoney(item.unitAmount.minorUnits, item.unitAmount.currency)})`
          : item.description,
      amount: formatMoney(item.amount.minorUnits, item.amount.currency),
    })),
    ...quote.fees.map((fee) => ({
      key: `f-${fee.code}`,
      label: fee.description,
      amount: formatMoney(fee.amount.minorUnits, fee.amount.currency),
    })),
    ...quote.taxes.map((tax) => ({
      key: `t-${tax.code}`,
      label: tax.description,
      amount: formatMoney(tax.amount.minorUnits, tax.amount.currency),
    })),
    ...quote.discounts.map((discount) => ({
      key: `d-${discount.code}`,
      label: discount.description,
      amount: `-${formatMoney(discount.amount.minorUnits, discount.amount.currency)}`,
    })),
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={quote.status === 'ISSUED' ? 'success' : 'warning'}>
          {quote.status === 'ISSUED' ? 'Issued' : 'Pending review'}
        </StatusChip>
        <span className="text-xs text-cream-50/50">version {quote.version}</span>
      </div>
      <dl className="mt-3 space-y-2 text-sm">
        {lines.map((line) => (
          <div key={line.key} className="flex justify-between gap-4">
            <dt className="text-cream-50/70">{line.label}</dt>
            <dd className="text-right tabular-nums text-cream-50">{line.amount}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 border-t border-white/10 pt-2 font-medium">
          <dt className="text-cream-50">Total</dt>
          <dd className="text-right tabular-nums text-cream-50" data-testid="quote-total">
            {formatMoney(quote.total.minorUnits, quote.total.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-cream-50/70">Security deposit</dt>
          <dd className="text-right tabular-nums text-cream-50">
            {formatMoney(quote.deposit.minorUnits, quote.deposit.currency)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-cream-50/50">
        Valid until {formatDateTime(quote.validUntil)}
      </p>
      {quote.reviewReasons.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-warning">
          {quote.reviewReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
