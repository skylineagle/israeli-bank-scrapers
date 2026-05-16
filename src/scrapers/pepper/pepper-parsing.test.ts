import {
  extractForeignCurrencyAmountsFromText,
  normalizePepperAccountNumber,
  parseCurrencyAmountSnippet,
} from './pepper';

describe('Pepper amount and account parsing', () => {
  test('parseCurrencyAmountSnippet ILS with leading shekel', () => {
    expect(parseCurrencyAmountSnippet('₪ 1,234.50')).toEqual({ amount: 1234.5, currency: 'ILS' });
    expect(parseCurrencyAmountSnippet('\u20aa500')).toEqual({ amount: 500, currency: 'ILS' });
  });

  test('parseCurrencyAmountSnippet ILS with trailing shekel', () => {
    expect(parseCurrencyAmountSnippet('1,234.50 ₪')).toEqual({ amount: 1234.5, currency: 'ILS' });
    expect(parseCurrencyAmountSnippet('-99.00\u20aa')).toEqual({ amount: -99, currency: 'ILS' });
  });

  test('parseCurrencyAmountSnippet USD after amount (RTL-style)', () => {
    expect(parseCurrencyAmountSnippet('1,234.50 $')).toEqual({ amount: 1234.5, currency: 'USD' });
  });

  test('extractForeignCurrencyAmountsFromText finds USD on מט״ח row', () => {
    const xs = extractForeignCurrencyAmountsFromText('מט״ח 1,200.50 $');
    expect(xs).toEqual(expect.arrayContaining([{ amount: 1200.5, currency: 'USD' }]));
  });

  test('extractForeignCurrencyAmountsFromText ISO codes', () => {
    const xs = extractForeignCurrencyAmountsFromText('יתרה USD 99.00 + EUR 12.50');
    expect(xs).toEqual(
      expect.arrayContaining([
        { amount: 99, currency: 'USD' },
        { amount: 12.5, currency: 'EUR' },
      ]),
    );
  });

  test('normalizePepperAccountNumber strips leading label', () => {
    expect(normalizePepperAccountNumber('חשבון  12-345-678901')).toBe('12-345-678901');
  });

  test('normalizePepperAccountNumber labeled digits only (any real length in range)', () => {
    expect(normalizePepperAccountNumber('חשבון 123456789')).toBe('123456789');
  });

  test('normalizePepperAccountNumber masked suffix becomes digits', () => {
    expect(normalizePepperAccountNumber('חשבון **4521')).toBe('4521');
  });
});
