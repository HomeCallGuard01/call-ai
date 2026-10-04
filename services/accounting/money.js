// Money in integer minor units (pence). Floats never carry accounting amounts.
'use strict';

function toMinor(value, { label = 'amount' } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) throw new Error(`${label} is not a number`);
  return Math.round(n * 100);
}

function assertMinor(value, label = 'amount') {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer number of minor units`);
  return value;
}

function formatMinor(minor, currency = 'GBP') {
  if (minor === null || minor === undefined) return 'unknown';
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${currency} ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function normaliseCurrency(code) {
  if (typeof code !== 'string' || !/^[a-zA-Z]{3}$/.test(code)) return null;
  return code.toUpperCase();
}

module.exports = { toMinor, assertMinor, formatMinor, normaliseCurrency };
