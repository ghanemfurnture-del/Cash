import { describe, it, expect } from 'vitest';
import { add, sub, mul, div, round, formatMoney, formatQty, isEqual } from '../src/core/decimal';

describe('Accounting Decimal Math (Arbitrary Precision)', () => {
  it('solves classic floating point precision bugs (0.1 + 0.2 === 0.3)', () => {
    const result = add('0.1', '0.2');
    expect(result.toString()).toBe('0.3');
    expect(isEqual(result, '0.3')).toBe(true);
  });

  it('performs high-precision addition and subtraction correctly', () => {
    const sum = add('1000.5055', '2000.4945');
    expect(sum.toString()).toBe('3001');

    const difference = sub('5000.0000', '1234.5678');
    expect(difference.toString()).toBe('3765.4322');
  });

  it('performs multiplication with unit prices and tax rates', () => {
    // 15 items @ 24.50 EGP with VAT 14%
    const subtotal = mul('15', '24.50');
    expect(subtotal.toString()).toBe('367.5');

    const tax = mul(subtotal, '0.14');
    expect(tax.toString()).toBe('51.45');

    const total = add(subtotal, tax);
    expect(total.toString()).toBe('418.95');
  });

  it('safely handles division by zero', () => {
    const zeroDiv = div('1000', '0');
    expect(zeroDiv.toString()).toBe('0');
  });

  it('respects ROUND_HALF_UP rounding policy', () => {
    // 0.005 rounds up to 0.01
    expect(round('0.005', 2).toString()).toBe('0.01');
    // 0.004 rounds down to 0.00
    expect(round('0.004', 2).toString()).toBe('0');
    // 0.015 rounds up to 0.02
    expect(round('0.015', 2).toString()).toBe('0.02');
  });

  it('formats money and quantities with clean Egyptian formatting', () => {
    const formatted = formatMoney('1234567.89', 'EGP', 'en-US');
    expect(formatted).toBe('1,234,567.89 EGP');

    const qty = formatQty('150.5000', 'en-US');
    expect(qty).toBe('150.5');
  });
});
