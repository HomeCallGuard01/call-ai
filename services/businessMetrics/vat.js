// vat.js — pure VAT arithmetic for the business dashboard. AFMD Ltd is
// VAT registered; the consumer price (£4.99/month) is VAT-inclusive.
// This is the ONE place that split is computed — every revenue figure
// the dashboard shows is built from this, never a second, independently-
// maintained VAT calculation.
'use strict';

// Splits a VAT-inclusive gross amount into its net (ex-VAT) and VAT
// components. Pure, no rounding surprises hidden inside a bigger
// function — net + vat always reconstructs the original gross to the
// penny (integers in) or as closely as floating point allows (decimals
// in), and the caller decides its own rounding/display precision.
function splitVatInclusive(grossAmount, vatRate) {
  const netAmount = grossAmount / (1 + vatRate);
  const vatAmount = grossAmount - netAmount;
  return { grossAmount, netAmount, vatAmount, vatRate };
}

module.exports = { splitVatInclusive };
