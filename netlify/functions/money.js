'use strict';

// Parse positive monetary values without silently stripping signs or decimal separators.
// Supports plain numbers and correctly grouped thousands, with up to two decimal places.
module.exports = function parseMoney(value) {
  const raw = typeof value === 'number'
    ? String(value)
    : String(value == null ? '' : value).trim().replace(/\s/g, '');
  if (!raw) return 0;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) return 0;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
