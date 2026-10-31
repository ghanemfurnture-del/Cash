import Decimal from 'decimal.js';

/**
 * Global Configuration for Accounting and ERP Math
 * Configurable parameters with documented defaults.
 * Rounded using standard arithmetic Half-Up (ROUND_HALF_UP).
 */
export const MathConfig = {
  // Precision settings
  moneyDecimals: 2,           // Standard Egyptian Pound (EGP) currency display & storage
  unitPriceDecimals: 4,       // Unit price precision in documents (configurable up to 5/6)
  quantityDecimals: 4,        // Quantity precision for inventory & conversions
  exchangeRateDecimals: 6,    // Currency exchange rates
  taxRateDecimals: 4,         // Tax percentages (e.g. 0.1400 for VAT 14%)
  
  // Rounding mode: 4 = ROUND_HALF_UP
  roundingMode: Decimal.ROUND_HALF_UP,
  maxCalculationPrecision: 20,
};

// Apply default Decimal.js configuration
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
