import Decimal from 'decimal.js';

/**
 * Global Configuration for Accounting and ERP Math
 *
 * CRITICAL ETA COMPLIANCE NOTICE:
 * All rounding modes, decimal precisions, and calculation tolerances below
 * are currently UNVERIFIED PLACEHOLDERS based on preliminary SDK references.
 *
 * WHAT MUST BE VERIFIED AGAINST OFFICIAL ETA SDK (sdk.invoicing.eta.gov.eg) BEFORE PHASE 11:
 * 1. Required arithmetic rounding mode: ROUND_HALF_UP vs Banker's ROUND_HALF_EVEN vs truncation.
 * 2. Unit price precision: whether ETA strictly requires 5 decimal places (e.g. 10.50000) or accepts 2-5.
 *    If 5 decimals are confirmed, propose a new numbered migration 004_eta_unit_price_decimals.sql (DO NOT edit 001/002).
 * 3. Calculation cross-check rules: formula for line netAmount and acceptable delta threshold (e.g. ±0.01 EGP).
 * 4. Canonical string serialization algorithm (RFC 8785 vs custom JSON canonicalization).
 * 5. Signature type: CAdES-BES (DER vs Base64-wrapped CMS).
 * 6. Document versions: e-invoice v1.0 and POS e-receipt v1.2 / v1.0.
 */
export const MathConfig = {
  // Precision settings [UNVERIFIED ETA PLACEHOLDER - MUST BE VERIFIED BEFORE PHASE 11]
  moneyDecimals: 2,           // [UNVERIFIED ETA PLACEHOLDER] Egyptian Pound (EGP) document display/totals
  unitPriceDecimals: 4,       // [UNVERIFIED ETA PLACEHOLDER] Unit price precision (may need 5 in Phase 11)
  quantityDecimals: 4,        // Quantity precision for inventory movements and unit conversions
  exchangeRateDecimals: 6,    // Foreign exchange rate precision
  taxRateDecimals: 4,         // [UNVERIFIED ETA PLACEHOLDER] Tax percentages (e.g. 0.1400 for VAT 14%)
  calculationTolerance: 0.01, // [UNVERIFIED ETA PLACEHOLDER] Allowable document rounding drift

  // Rounding mode: 4 = ROUND_HALF_UP [UNVERIFIED ETA PLACEHOLDER - MUST BE VERIFIED BEFORE PHASE 11]
  roundingMode: Decimal.ROUND_HALF_UP,
  maxCalculationPrecision: 20,
};

// Apply configured Decimal.js settings
Decimal.set({
  precision: MathConfig.maxCalculationPrecision,
  rounding: MathConfig.roundingMode,
});

export type DecimalSource = string | number | Decimal;

/**
 * Safely parse a value into a Decimal instance.
 * Rejects NaN, returns Decimal(0) for null/undefined/empty string.
 */
export function toDecimal(value?: DecimalSource | null): Decimal {
  if (value === null || value === undefined || value === '') {
    return new Decimal(0);
  }
  if (value instanceof Decimal) {
    return value;
  }
  try {
    return new Decimal(value);
  } catch {
    return new Decimal(0);
  }
}

/**
 * Add two or more values with exact decimal precision.
 */
export function add(a: DecimalSource, b: DecimalSource, ...rest: DecimalSource[]): Decimal {
  let result = toDecimal(a).plus(toDecimal(b));
  for (const item of rest) {
    result = result.plus(toDecimal(item));
  }
  return result;
}

/**
 * Subtract values (a - b - ...rest) with exact decimal precision.
 */
export function sub(a: DecimalSource, b: DecimalSource, ...rest: DecimalSource[]): Decimal {
  let result = toDecimal(a).minus(toDecimal(b));
  for (const item of rest) {
    result = result.minus(toDecimal(item));
  }
  return result;
}

/**
 * Multiply values (a * b * ...rest) with exact decimal precision.
 */
export function mul(a: DecimalSource, b: DecimalSource, ...rest: DecimalSource[]): Decimal {
  let result = toDecimal(a).times(toDecimal(b));
  for (const item of rest) {
    result = result.times(toDecimal(item));
  }
  return result;
}

/**
 * Divide a by b with safe zero handling and exact decimal precision.
 */
export function div(a: DecimalSource, b: DecimalSource): Decimal {
  const divisor = toDecimal(b);
  if (divisor.isZero()) {
    return new Decimal(0);
  }
  return toDecimal(a).dividedBy(divisor);
}

/**
 * Round a decimal to specified number of decimal places (default = 2 for money).
 */
export function round(value: DecimalSource, decimals: number = MathConfig.moneyDecimals): Decimal {
  return toDecimal(value).toDecimalPlaces(decimals, MathConfig.roundingMode);
}

/**
 * Compare two decimals:
 * returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compare(a: DecimalSource, b: DecimalSource): number {
  return toDecimal(a).comparedTo(toDecimal(b));
}

/**
 * Check if a is equal to b.
 */
export function isEqual(a: DecimalSource, b: DecimalSource): boolean {
  return toDecimal(a).equals(toDecimal(b));
}

/**
 * Format decimal as currency string with comma thousands separator.
 */
export function formatMoney(
  value: DecimalSource,
  currency: string = 'EGP',
  locale: string = 'ar-EG'
): string {
  const num = round(value, MathConfig.moneyDecimals).toNumber();
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: MathConfig.moneyDecimals,
    maximumFractionDigits: MathConfig.moneyDecimals,
  }).format(num);
  return `${formatted} ${currency}`;
}

/**
 * Format quantity with appropriate decimals, trimming trailing zeros.
 */
export function formatQty(value: DecimalSource, locale: string = 'ar-EG'): string {
  const num = round(value, MathConfig.quantityDecimals).toNumber();
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: MathConfig.quantityDecimals,
  }).format(num);
}
