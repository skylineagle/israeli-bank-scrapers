import { stripBidirectionalAndTrim } from '../../helpers/text';
import { type CurrencyAmount } from '../../transactions';
import { ISRAELI_PHONE_COUNTRY_CODE } from './pepper-selectors';
import { type SymbolCurrency } from './pepper-types';

const AMOUNT_FRAGMENT = String.raw`[\d,.\-+]+`;
const ILS_SYMBOL_PATTERN = '₪|\\u20aa';
const ISO_CURRENCY_CODES_PATTERN = 'USD|EUR|GBP|CHF|JPY|CAD|AUD|PLN';

/** Currency symbols in the priority order used to pick a single amount from compound text. */
const SYMBOL_CURRENCIES: readonly SymbolCurrency[] = [
  { currency: 'ILS', symbolPattern: ILS_SYMBOL_PATTERN },
  { currency: 'USD', symbolPattern: '\\$' },
  { currency: 'GBP', symbolPattern: '£' },
  { currency: 'JPY', symbolPattern: '¥' },
  { currency: 'EUR', symbolPattern: '€' },
];

const leadingAmountRegex = (symbolPattern: string, flags = ''): RegExp =>
  new RegExp(`(?:${symbolPattern})\\s*(${AMOUNT_FRAGMENT})`, flags);

const trailingAmountRegex = (symbolPattern: string, flags = ''): RegExp =>
  new RegExp(`(${AMOUNT_FRAGMENT})\\s*(?:${symbolPattern})`, flags);

const isoLeadingRegex = (): RegExp =>
  new RegExp(`\\b(${ISO_CURRENCY_CODES_PATTERN})\\b\\s*[:\\s]*(${AMOUNT_FRAGMENT})`, 'gi');

const isoTrailingRegex = (): RegExp =>
  new RegExp(`(${AMOUNT_FRAGMENT})\\s*\\b(${ISO_CURRENCY_CODES_PATTERN})\\b`, 'gi');

function parseAmountFragment(fragment: string): number {
  return parseFloat(fragment.replace(/,/g, ''));
}

function forEachMatch(regex: RegExp, text: string, onMatch: (match: RegExpExecArray) => void): void {
  let match = regex.exec(text);
  while (match != null) {
    onMatch(match);
    match = regex.exec(text);
  }
}

/** Parse the first currency amount from a text snippet, preferring symbols (ILS first) over ISO codes. */
export function parseCurrencyAmountSnippet(raw: string): CurrencyAmount | undefined {
  const text = stripBidirectionalAndTrim(raw);
  if (!text) {
    return undefined;
  }

  for (const { currency, symbolPattern } of SYMBOL_CURRENCIES) {
    const leading = text.match(leadingAmountRegex(symbolPattern));
    if (leading) {
      const amount = parseAmountFragment(leading[1]);
      if (Number.isFinite(amount)) {
        return { amount, currency };
      }
    }
    const trailing = text.match(trailingAmountRegex(symbolPattern));
    if (trailing) {
      const amount = parseAmountFragment(trailing[1]);
      if (Number.isFinite(amount)) {
        return { amount, currency };
      }
    }
  }

  let isoResult: CurrencyAmount | undefined;
  forEachMatch(isoLeadingRegex(), text, match => {
    if (isoResult) {
      return;
    }
    const amount = parseAmountFragment(match[2]);
    if (Number.isFinite(amount)) {
      isoResult = { amount, currency: match[1].toUpperCase() };
    }
  });
  if (isoResult) {
    return isoResult;
  }
  forEachMatch(isoTrailingRegex(), text, match => {
    if (isoResult) {
      return;
    }
    const amount = parseAmountFragment(match[1]);
    if (Number.isFinite(amount)) {
      isoResult = { amount, currency: match[2].toUpperCase() };
    }
  });
  return isoResult;
}

function scanAllCurrencyAmounts(text: string): CurrencyAmount[] {
  const results: CurrencyAmount[] = [];
  const pushFinite = (currency: string, fragment: string): void => {
    const amount = parseAmountFragment(fragment);
    if (Number.isFinite(amount)) {
      results.push({ amount, currency });
    }
  };

  for (const { currency, symbolPattern } of SYMBOL_CURRENCIES) {
    forEachMatch(leadingAmountRegex(symbolPattern, 'g'), text, match => pushFinite(currency, match[1]));
    forEachMatch(trailingAmountRegex(symbolPattern, 'g'), text, match => pushFinite(currency, match[1]));
  }
  forEachMatch(isoLeadingRegex(), text, match => pushFinite(match[1].toUpperCase(), match[2]));
  forEachMatch(isoTrailingRegex(), text, match => pushFinite(match[2].toUpperCase(), match[1]));

  return results;
}

/** Remove duplicate amounts, keeping the first occurrence of each currency/amount pair. */
export function dedupeCurrencyAmounts(amounts: readonly CurrencyAmount[]): CurrencyAmount[] {
  const seen = new Set<string>();
  return amounts.filter(({ currency, amount }) => {
    const key = `${currency}:${amount}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Extract every non-ILS currency amount found in the text, deduplicated. */
export function extractForeignCurrencyAmountsFromText(raw: string): CurrencyAmount[] {
  const text = stripBidirectionalAndTrim(raw);
  if (!text) {
    return [];
  }
  const foreign = scanAllCurrencyAmounts(text).filter(({ currency }) => currency !== 'ILS');
  return dedupeCurrencyAmounts(foreign);
}

/** Return the first ILS amount from compound text (leading symbol preferred over trailing). */
export function firstIlsAmountFromCompoundText(raw: string): number | undefined {
  const text = stripBidirectionalAndTrim(raw);
  const leading = text.match(leadingAmountRegex(ILS_SYMBOL_PATTERN));
  if (leading) {
    const amount = parseAmountFragment(leading[1]);
    return Number.isFinite(amount) ? amount : undefined;
  }
  const trailing = text.match(trailingAmountRegex(ILS_SYMBOL_PATTERN));
  if (trailing) {
    const amount = parseAmountFragment(trailing[1]);
    return Number.isFinite(amount) ? amount : undefined;
  }
  return undefined;
}

const LABELED_ACCOUNT_REGEX = /חשבון\s*[:\s]*([\d\s\-*•\u2022]+)/u;
const DASHED_ACCOUNT_REGEX = /^\d{1,3}-\d{1,3}-\d{3,}$/;

export function normalizePepperAccountNumber(raw: string): string {
  const text = stripBidirectionalAndTrim(raw);
  const labeled = text.match(LABELED_ACCOUNT_REGEX);
  if (labeled) {
    const chunk = stripBidirectionalAndTrim(labeled[1]).replace(/\s+/g, '').replace(/•/g, '*');
    if (DASHED_ACCOUNT_REGEX.test(chunk)) {
      return chunk;
    }
    const digitsOnly = chunk.replace(/\D/g, '');
    return digitsOnly.length >= 4 ? digitsOnly : chunk;
  }
  return stripBidirectionalAndTrim(text.replace(/^חשבון\s*/u, ''));
}

const COMPACT_DIGITS_ACCOUNT_REGEX = /^\d{4,14}$/;
const DASHED_DIGITS_ACCOUNT_REGEX = /^\d{1,3}-\d{1,3}-\d{3,}$/;
const DASHED_MASKED_ACCOUNT_REGEX = /^\d{1,3}-\d{1,3}-[\d*•]{3,}$/;

export function isLikelyPepperAccountToken(normalized: string): boolean {
  const compact = normalized.replace(/\s/g, '');
  if (COMPACT_DIGITS_ACCOUNT_REGEX.test(compact) || DASHED_DIGITS_ACCOUNT_REGEX.test(compact)) {
    return true;
  }
  if (DASHED_MASKED_ACCOUNT_REGEX.test(compact)) {
    return compact.replace(/\D/g, '').length >= 4;
  }
  return false;
}

/** Normalize an Israeli phone number to E.164 form (e.g. 0501234567 -> +972501234567). */
export function toIsraeliE164Phone(phone: string): string {
  if (phone.startsWith(ISRAELI_PHONE_COUNTRY_CODE)) {
    return phone;
  }
  return `${ISRAELI_PHONE_COUNTRY_CODE}${phone.replace(/^0/, '')}`;
}

/** Convert an E.164-like Israeli number to the local digits a dialer screen expects (e.g. 0501234567). */
export function toIsraeliDialerDigits(e164LikePhone: string): string {
  const withoutCountryCode = e164LikePhone.replace(/\s/g, '').replace(/^\+?972/, '');
  const digits = withoutCountryCode.replace(/\D/g, '');
  if (digits.length === 9 && digits.startsWith('5')) {
    return `0${digits}`;
  }
  return digits;
}
