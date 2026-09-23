export const DECISION_LABELS = {
  approve: 'Approved',
  deny: 'Denied',
  review: 'Needs review'
};

const moneyFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

export const money = (n) => moneyFormat.format(Number(n) || 0);

export const dateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '—';

export const duration = (ms) => (ms < 1 ? '<1 ms' : `${Math.round(ms)} ms`);

export const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '—');
