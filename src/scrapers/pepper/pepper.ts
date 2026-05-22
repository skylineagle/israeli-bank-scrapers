import { getDebug } from '../../helpers/debug';
import { sleep, TimeoutError } from '../../helpers/waiting';
import { type CurrencyAmount, type TransactionsAccount } from '../../transactions';
import { BaseAndroidAppScraper } from '../base-android-app-scraper';
import { ScraperErrorTypes } from '../errors';
import { type ScraperLoginResult, type ScraperScrapingResult } from '../interface';

type AccountTotals = Pick<TransactionsAccount, 'savings' | 'investments' | 'foreignCurrency'>;

const debug = getDebug('pepper');

const PACKAGE_NAME = 'com.pepper.ldb';

const ua = (selectorExpr: string) => `android=new UiSelector().${selectorExpr}`;

const LOGIN_UI_WAIT_MS = 45_000;

const SEL = {
  phoneInput: `//android.widget.EditText[@resource-id="${PACKAGE_NAME}:id/etPhoneNumber"]`,
  otpInput: `//android.widget.EditText[@resource-id="${PACKAGE_NAME}:id/etOtp"]`,
  continueBtn: `//android.widget.Button[@resource-id="${PACKAGE_NAME}:id/btnContinue"]`,
  verifyOtpBtn: `//android.widget.Button[@resource-id="${PACKAGE_NAME}:id/btnVerify"]`,
  transactionsTab: `//android.widget.TextView[@resource-id="${PACKAGE_NAME}:id/tvTransactions"]`,
} as const;

const PEPPER_BOTTOM_NAV_HOME_SELECTORS: readonly string[] = [
  '//android.view.View[@content-desc="בית"][@clickable="true"]',
  '//*[@content-desc="בית"][@clickable="true"]',
];

const PEPPER_HOME_TAB_SELECTORS: readonly string[] = [
  ...PEPPER_BOTTOM_NAV_HOME_SELECTORS,
  '//android.widget.TextView[@text="בית"]',
  '//*[@text="בית" and (@clickable="true" or @focusable="true")]',
  ua('textContains("בית").clickable(true)'),
  ua('descriptionContains("בית")'),
];

const PEPPER_HOME_DASHBOARD_READY_SELECTORS: readonly string[] = [
  '//android.widget.Button[contains(@text,"זאת היתרה")]',
  '//*[@clickable="true"][contains(@text,"זאת היתרה")]',
  ua('textContains("זאת היתרה").clickable(true)'),
  '//*[contains(@text,"חסכונות")]',
  '//*[contains(@content-desc,"חסכונות")]',
  ua('textContains("חסכונות")'),
  ua('descriptionContains("חסכונות")'),
];

const PEPPER_PROFILE_SCREEN_SELECTORS: readonly string[] = [
  ua('textContains("פרטי חשבון")'),
  ua('textContains("פרופיל")'),
  ua('descriptionContains("פרופיל")'),
  ua('textContains("העתק")'),
  ua('descriptionContains("העתק")'),
  '//*[contains(@text,"העתקת") or contains(@content-desc,"העתקת")]',
  '//*[contains(@text,"מספר חשבון") or contains(@content-desc,"מספר חשבון")]',
];

const PEPPER_LOGGED_IN_SELECTORS: readonly string[] = [
  ...PEPPER_HOME_DASHBOARD_READY_SELECTORS,
  ...PEPPER_BOTTOM_NAV_HOME_SELECTORS,
  ua('textContains("זאת היתרה")'),
  ua('textContains("יתרה שלך")'),
  '//android.widget.TextView[contains(@text,"יתרה שלך")]',
  '//*[contains(@text,"תנועות אחרונות")]',
  ua('textContains("תנועות אחרונות")'),
  '//*[contains(@text,"העברת כסף")]',
  ua('textContains("העברת כסף")'),
  ua(`resourceIdMatches("${PACKAGE_NAME}:id/.*[Bb]alance.*").className("android.widget.TextView")`),
  `//*[contains(@resource-id,'${PACKAGE_NAME}:id/')][contains(@resource-id,'Balance')]`,
  '//*[@text="פעולות"]',
  ua('textContains("פעולות").clickable(true)'),
  SEL.transactionsTab,
  ua(`resourceId("${PACKAGE_NAME}:id/tvTransactions")`),
  ua('descriptionContains("יתרה")'),
];

const PEPPER_BALANCE_SELECTORS: readonly string[] = [
  "//*[contains(@resource-id,'Balance')]",
  ua('resourceIdMatches("(?i).*balance.*").className("android.widget.TextView")'),
  ua(`resourceIdMatches("${PACKAGE_NAME}:id/.*[Bb]alance.*").className("android.widget.TextView")`),
  "//*[contains(@text,'₪') or contains(@text,'\u20aa') or contains(@content-desc,'₪') or contains(@content-desc,'\u20aa')]",
  ua('descriptionContains("יתרה")'),
  ua('textContains("יתרה")'),
  '//android.widget.Button[contains(@text,"זאת היתרה")]',
  '//*[@clickable="true"][contains(@text,"זאת היתרה")]',
];

const PEPPER_HERO_BALANCE_COMPOUND_SELECTORS: readonly string[] = [
  '//android.widget.Button[contains(@text,"זאת היתרה")]',
  '//*[@clickable="true"][contains(@text,"זאת היתרה")]',
  ua('textContains("זאת היתרה").clickable(true)'),
];

const PEPPER_PHONE_SELECTORS_STRICT: readonly string[] = [
  SEL.phoneInput,
  ua(`resourceId("${PACKAGE_NAME}:id/etPhoneNumber")`),
  '//android.widget.EditText[@content-desc="מספר טלפון"]',
  "//android.widget.EditText[contains(@content-desc,'טלפון')]",
  ua('descriptionContains("מספר טלפון")'),
  ua('descriptionContains("טלפון")'),
  "//android.widget.EditText[contains(@resource-id,'etPhoneNumber')]",
  "//android.widget.EditText[contains(@resource-id,'phone')]",
  "//android.widget.EditText[contains(@resource-id,'Phone')]",
  "//android.widget.EditText[contains(@resource-id,'mobile')]",
  "//android.widget.EditText[contains(@resource-id,'Mobile')]",
  "//android.widget.EditText[contains(@resource-id,'tel')]",
  ua('resourceIdMatches("(?i).*phone.*").className("android.widget.EditText")'),
];

const PEPPER_PHONE_SELECTORS: readonly string[] = [
  ...PEPPER_PHONE_SELECTORS_STRICT,
  ua('descriptionContains("טלפון")'),
  ua('descriptionContains("נייד")'),
];

const PEPPER_WELCOME_CONTINUE_SELECTORS: readonly string[] = [
  // Exact texts observed on the welcome screen (login button, not register)
  ua('text("כניסה לחשבון שלי")'),
  ua('descriptionContains("כניסה לחשבון שלי")'),
  '//*[@content-desc="כניסה לחשבון שלי"]',
  ua('textContains("לחשבון שלי")'),
  // Older / alternate welcome button texts
  ua('text("כניסה")'),
  ua('textContains("יש לי חשבון")'),
  ua('textContains("בואו נתחיל")'),
  ua('textContains("להמשיך")'),
  ua('textMatches("(?i).*start.*")'),
  ua('resourceIdMatches("(?i).*welcome.*").clickable(true)'),
  "//android.widget.Button[contains(@resource-id,'continue')]",
  "//android.widget.Button[contains(@resource-id,'start')]",
  // NOTE: no instance(0) catch-all — that would tap the register button first
];

const PEPPER_CONTINUE_SELECTORS: readonly string[] = [
  SEL.continueBtn,
  ua('classNameContains("FloatingActionButton").clickable(true)'),
  ua('resourceIdMatches("(?i).*fab.*").clickable(true)'),
  ua('resourceIdMatches("(?i).*next.*").clickable(true)'),
  ua('resourceIdMatches("(?i).*submit.*").clickable(true)'),
  ua('descriptionMatches("(?i).*next.*")'),
  ua('descriptionMatches("(?i).*arrow.*")'),
  ua('descriptionContains("הבא")'),
  ua('descriptionContains("המשך")'),
  ua('resourceIdMatches("(?i).*continue.*").clickable(true)'),
  ua('textMatches("(?i).*continue.*")'),
  '//android.widget.Button[@text="המשך"]',
  '//*[@text="המשך"]',
  ua('textContains("המשך")'),
  ua('textContains("הבא")'),
];

const PEPPER_POST_CREDENTIALS_SUBMIT_SELECTORS: readonly string[] = [
  '//*[@text="כניסה לחשבון"]',
  "//android.widget.Button[contains(@text,'כניסה לחשבון')]",
  ua('textContains("כניסה לחשבון")'),
  ua('descriptionContains("כניסה לחשבון")'),
  SEL.continueBtn,
  ua('resourceIdMatches("(?i).*login.*").clickable(true)'),
  ua('resourceIdMatches("(?i).*signin.*").clickable(true)'),
  ua('resourceIdMatches("(?i).*sign_in.*").clickable(true)'),
  ua('classNameContains("FloatingActionButton").clickable(true)'),
  ua('resourceIdMatches("(?i).*fab.*").clickable(true)'),
  ua('resourceIdMatches("(?i).*submit.*").clickable(true)'),
  ua('resourceIdMatches("(?i).*continue.*").clickable(true)'),
  '//*[@text="המשך"]',
  ua('textContains("המשך")'),
];

const PEPPER_PASSWORD_SELECTORS: readonly string[] = [
  ua(`resourceId("${PACKAGE_NAME}:id/etPassword")`),
  ua('descriptionContains("סיסמה")'),
  "//android.widget.EditText[contains(@hint,'סיסמה')]",
  "//android.widget.EditText[contains(@resource-id,'password')]",
  "//android.widget.EditText[contains(@resource-id,'Password')]",
  ua('resourceIdMatches("(?i).*password.*").className("android.widget.EditText")'),
  '//android.widget.EditText[@password="true"]',
];

// Pepper has shipped at least two OTP screen variants:
//   (a) Custom RN widget with 6 ViewGroup boxes (resource-id="otp-input") + custom keyboard
//   (b) Standard single EditText with 6 underline positions + system soft keyboard
// We detect both. Entry is handled by enterPepperOtpCode().
const PEPPER_OTP_INPUT_SELECTORS: readonly string[] = [
  '//*[@resource-id="otp-input"]',
  '//*[@resource-id="accessible-rect-button"]',
  '//*[@resource-id="otpScreen.phoneMessage"]',
  SEL.otpInput,
  "//android.widget.EditText[contains(@resource-id,'otp')]",
  "//android.widget.EditText[contains(@resource-id,'Otp')]",
  ua('resourceIdMatches("(?i).*otp.*").className("android.widget.EditText")'),
];

const PEPPER_OTP_SCREEN_MARKERS: readonly string[] = [
  '//*[@resource-id="otpScreen.phoneMessage"]',
  ua('textContains("שלחנו לך קוד")'),
  ua('textContains("מה הקוד שקיבלת")'),
  ua('textContains("קוד האימות")'),
  ua('descriptionContains("קוד האימות")'),
  ua('textContains("הקוד לא הגיע")'),
  ua('textContains("הודעה קולית")'),
  // Fallback: any EditText on screen while we know we are past the password step
  // (login form is not visible) — Pepper variant (b) uses a plain EditText.
];

const PEPPER_NOTIFICATION_POPUP_SELECTORS: readonly string[] = [
  '//android.widget.TextView[@text="רוצה להישאר בעניינים?"]',
  ua('textContains("רוצה להישאר בעניינים?")'),
  '//android.widget.Button[@content-desc="סגירה"]',
];

const PEPPER_NOTIFICATION_POPUP_DISMISS_SELECTORS: readonly string[] = [
  '//*[@text="בפעם אחרת"]',
  ua('textContains("בפעם אחרת")'),
  '//android.widget.Button[@content-desc="סגירה"]',
  ua('descriptionContains("סגירה").clickable(true)'),
];

const PEPPER_TERMS_SCREEN_SELECTORS: readonly string[] = [
  '//android.widget.Button[@content-desc="אני מסכימ/ה"]',
  ua('descriptionContains("אני מסכימ/ה").clickable(true)'),
  '//android.widget.CheckBox[@resource-id="pressable"]',
  ua('textContains("תנאי השימוש")'),
  ua('textContains("רגע לפני שמתחילים")'),
];

const PEPPER_TERMS_CHECKBOX_SELECTORS: readonly string[] = [
  '//android.widget.CheckBox[@resource-id="pressable"]',
  ua('className("android.widget.CheckBox").clickable(true)'),
];

const PEPPER_TERMS_AGREE_SELECTORS: readonly string[] = [
  '//android.widget.Button[@content-desc="אני מסכימ/ה"]',
  ua('descriptionContains("אני מסכימ/ה").clickable(true)'),
  ua('textContains("אני מסכימ").clickable(true)'),
  '//android.widget.Button[@resource-id="pressable"]',
];

const PEPPER_VERIFY_SELECTORS: readonly string[] = [
  SEL.verifyOtpBtn,
  ua('resourceIdMatches("(?i).*verify.*").clickable(true)'),
  ua('textMatches("(?i).*verify.*")'),
  '//android.widget.Button[@text="אימות"]',
  '//*[@text="אימות"]',
  ua('textContains("אימות")'),
  ua('descriptionContains("אימות")'),
  ua('textContains("אשר")'),
];

const AMOUNT_STRIP_REGEX = /[₪,\s]/g;

function stripBidiAndTrim(raw: string): string {
  return raw
    .replace(/\u200e|\u200f|\u061c/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizePepperAccountNumber(raw: string): string {
  const t = stripBidiAndTrim(raw);
  const labeled = t.match(/חשבון\s*[:\s]*([\d\s\-*•\u2022]+)/u);
  if (labeled) {
    const chunk = stripBidiAndTrim(labeled[1]).replace(/\s+/g, '').replace(/•/g, '*');
    if (/^\d{1,3}-\d{1,3}-\d{3,}$/.test(chunk)) {
      return chunk;
    }
    const digitsOnly = chunk.replace(/\D/g, '');
    if (digitsOnly.length >= 4) {
      return digitsOnly;
    }
    return chunk;
  }
  return t
    .replace(/^חשבון\s*/u, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function parseCurrencyAmountSnippet(raw: string): CurrencyAmount | undefined {
  const t = stripBidiAndTrim(raw);
  if (!t) {
    return undefined;
  }

  const ils = t.match(/(?:₪|\u20aa)\s*([\d,.\-+]+)/);
  if (ils) {
    return { amount: parseFloat(ils[1].replace(/,/g, '')), currency: 'ILS' };
  }

  const ilsTrailing = t.match(/([\d,.\-+]+)\s*(?:₪|\u20aa)/);
  if (ilsTrailing) {
    return { amount: parseFloat(ilsTrailing[1].replace(/,/g, '')), currency: 'ILS' };
  }

  const usd = t.match(/\$\s*([\d,.\-+]+)/);
  if (usd) {
    return { amount: parseFloat(usd[1].replace(/,/g, '')), currency: 'USD' };
  }

  const usdTrailing = t.match(/([\d,.\-+]+)\s*\$/);
  if (usdTrailing) {
    return { amount: parseFloat(usdTrailing[1].replace(/,/g, '')), currency: 'USD' };
  }

  const gbp = t.match(/£\s*([\d,.\-+]+)|([\d,.\-+]+)\s*£/);
  if (gbp) {
    const frag = gbp[1] ?? gbp[2];
    if (frag) {
      return { amount: parseFloat(frag.replace(/,/g, '')), currency: 'GBP' };
    }
  }

  const jpy = t.match(/¥\s*([\d,.\-+]+)|([\d,.\-+]+)\s*¥/);
  if (jpy) {
    const frag = jpy[1] ?? jpy[2];
    if (frag) {
      return { amount: parseFloat(frag.replace(/,/g, '')), currency: 'JPY' };
    }
  }

  const eur = t.match(/€\s*([\d,.\-+]+)|([\d,.\-+]+)\s*€/i);
  if (eur) {
    const frag = eur[1] ?? eur[2];
    if (!frag) {
      return undefined;
    }
    return { amount: parseFloat(frag.replace(/,/g, '')), currency: 'EUR' };
  }

  const isoLead = /\b(USD|EUR|GBP|CHF|JPY|CAD|AUD|PLN)\b\s*[:\s]*([\d,.\-+]+)/gi;
  let im: RegExpExecArray | null;
  while ((im = isoLead.exec(t)) != null) {
    const cur = im[1].toUpperCase();
    if (cur === 'ILS') {
      continue;
    }
    const amt = parseFloat(im[2].replace(/,/g, ''));
    if (Number.isFinite(amt)) {
      return { amount: amt, currency: cur };
    }
  }

  const isoTrail = /([\d,.\-+]+)\s*\b(USD|EUR|GBP|CHF|JPY|CAD|AUD|PLN)\b/gi;
  while ((im = isoTrail.exec(t)) != null) {
    const cur = im[2].toUpperCase();
    if (cur === 'ILS') {
      continue;
    }
    const amt = parseFloat(im[1].replace(/,/g, ''));
    if (Number.isFinite(amt)) {
      return { amount: amt, currency: cur };
    }
  }

  return undefined;
}

export function extractForeignCurrencyAmountsFromText(raw: string): CurrencyAmount[] {
  const t = stripBidiAndTrim(raw);
  if (!t) {
    return [];
  }

  const out: CurrencyAmount[] = [];
  const pushAll = (c?: CurrencyAmount) => {
    if (!c || c.currency === 'ILS' || !Number.isFinite(c.amount)) {
      return;
    }
    out.push(c);
  };

  pushAll(parseCurrencyAmountSnippet(t));

  const scanGroup1 = (re: RegExp, currency: string) => {
    const r = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(t)) != null) {
      const amt = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(amt)) {
        out.push({ amount: amt, currency });
      }
    }
  };

  scanGroup1(/\$\s*([\d,.\-+]+)/g, 'USD');
  scanGroup1(/([\d,.\-+]+)\s*\$/g, 'USD');
  scanGroup1(/€\s*([\d,.\-+]+)/g, 'EUR');
  scanGroup1(/([\d,.\-+]+)\s*€/gi, 'EUR');
  scanGroup1(/£\s*([\d,.\-+]+)/g, 'GBP');
  scanGroup1(/([\d,.\-+]+)\s*£/g, 'GBP');
  scanGroup1(/¥\s*([\d,.\-+]+)/g, 'JPY');
  scanGroup1(/([\d,.\-+]+)\s*¥/g, 'JPY');

  const isoLead = /\b(USD|EUR|GBP|CHF|JPY|CAD|AUD|PLN)\b\s*[:\s]*([\d,.\-+]+)/gi;
  let im: RegExpExecArray | null;
  while ((im = isoLead.exec(t)) != null) {
    const cur = im[1].toUpperCase();
    if (cur === 'ILS') {
      continue;
    }
    const amt = parseFloat(im[2].replace(/,/g, ''));
    if (Number.isFinite(amt)) {
      out.push({ amount: amt, currency: cur });
    }
  }

  const isoTrail = /([\d,.\-+]+)\s*\b(USD|EUR|GBP|CHF|JPY|CAD|AUD|PLN)\b/gi;
  while ((im = isoTrail.exec(t)) != null) {
    const cur = im[2].toUpperCase();
    if (cur === 'ILS') {
      continue;
    }
    const amt = parseFloat(im[1].replace(/,/g, ''));
    if (Number.isFinite(amt)) {
      out.push({ amount: amt, currency: cur });
    }
  }

  const seen = new Set<string>();
  return out.filter(c => {
    const k = `${c.currency}:${c.amount}`;
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

export function firstIlsAmountFromCompoundText(raw: string): number | undefined {
  const t = stripBidiAndTrim(raw);
  const re = /(?:₪|\u20aa)\s*([\d,.\-+]+)/g;
  const m = re.exec(t);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  const trailing = t.match(/([\d,.\-+]+)\s*(?:₪|\u20aa)/);
  if (trailing) {
    const n = parseFloat(trailing[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function mergeForeignAmounts(gather: CurrencyAmount[], next: CurrencyAmount[]): void {
  const keys = new Set(gather.map(c => `${c.currency}:${c.amount}`));
  for (const c of next) {
    if (c.currency === 'ILS') continue;
    const k = `${c.currency}:${c.amount}`;
    if (!keys.has(k)) {
      keys.add(k);
      gather.push(c);
    }
  }
}

export type PepperCredentials = {
  phoneNumber: string;
  password: string;
  otpCodeRetriever?: () => Promise<string>;
};

export type PepperDashboardProbeResult = {
  homeMarkers: {
    name: string;
    exists: boolean;
    displayed: boolean;
    accessibleTextPreview: string;
  }[];
  shekelMatchingNodeCount: number;
  topShekelSamples: { y: number; accessibleText: string }[];
  balanceAttempts: { path: string; value?: number; error?: string }[];
  foreignPivotScanCount?: number;
  foreignBroadScanCount?: number;
  foreignBroadScanPreview?: string[];
};

function normalizePhone(phone: string): string {
  if (phone.startsWith('+972')) {
    return phone;
  }
  return `+972${phone.replace(/^0/, '')}`;
}

function digitsForDialerScreen(e164Like: string): string {
  let n = e164Like.replace(/\s/g, '');
  if (n.startsWith('+972')) {
    n = n.slice(4);
  } else if (n.startsWith('972')) {
    n = n.slice(3);
  }

  const digits = n.replace(/\D/g, '');
  if (digits.length === 9 && digits.startsWith('5')) {
    return `0${digits}`;
  }
  if (digits.length === 10 && digits.startsWith('05')) {
    return digits;
  }
  if (digits.length === 10 && digits.startsWith('0')) {
    return digits;
  }
  return digits;
}

export default class PepperScraper extends BaseAndroidAppScraper<PepperCredentials> {
  get appPackage(): string {
    return PACKAGE_NAME;
  }

  private async readAccessibleText(el: {
    getText: () => Promise<string>;
    getAttribute: (name: string) => Promise<string | null>;
  }): Promise<string> {
    const chunks: string[] = [];
    const push = (s: string) => {
      const v = stripBidiAndTrim(s);
      if (v.length > 0 && v.toLowerCase() !== 'null' && !chunks.includes(v)) {
        chunks.push(v);
      }
    };

    try {
      push(await el.getText());
    } catch {}
    for (const name of ['content-desc', 'contentDescription', 'name', 'text']) {
      try {
        const a = await el.getAttribute(name);
        if (a == null || String(a).trim() === '' || String(a).toLowerCase() === 'null') {
          continue;
        }
        push(String(a));
      } catch {}
    }

    return stripBidiAndTrim(chunks.join(' '));
  }

  private async readBalanceFromShekelElementsScan(): Promise<number | undefined> {
    type Scored = { amount: number; y: number };
    const candidates: Scored[] = [];
    const selector =
      '//*[contains(@text,"₪") or contains(@text,"\u20aa") or contains(@content-desc,"₪") or contains(@content-desc,"\u20aa")]';

    try {
      const elements = await this.driver.$$(selector).getElements();
      for (const el of elements) {
        try {
          if (!(await el.isDisplayed())) {
            continue;
          }
          const raw = await this.readAccessibleText(el);
          const p = parseCurrencyAmountSnippet(raw);
          if (!p || p.currency !== 'ILS' || !Number.isFinite(p.amount)) {
            continue;
          }
          const loc = await el.getLocation().catch(() => ({ x: 0, y: 0 }));
          if (loc.y < 40) {
            continue;
          }
          candidates.push({ amount: p.amount, y: loc.y });
        } catch {
          continue;
        }
      }
    } catch (e) {
      debug('readBalanceFromShekelElementsScan failed: %s', e instanceof Error ? e.message : String(e));
      return undefined;
    }

    if (candidates.length === 0) {
      return undefined;
    }

    candidates.sort((a, b) => a.y - b.y);
    return candidates[0].amount;
  }

  private async readBalanceFromWalkAncestorsFromLabels(): Promise<number | undefined> {
    const needles = ['זאת היתרה', 'יתרה שלך', 'יתרה'];
    for (const needle of needles) {
      const sel = `//*[contains(@text,"${needle}") or contains(@content-desc,"${needle}")]`;
      try {
        let current = this.driver.$(sel);
        if (!(await current.isExisting())) {
          continue;
        }
        for (let depth = 0; depth < 8; depth++) {
          const raw = await this.readAccessibleText(current);
          const p = parseCurrencyAmountSnippet(raw);
          if (p?.currency === 'ILS' && Number.isFinite(p.amount)) {
            return p.amount;
          }
          const f = firstIlsAmountFromCompoundText(raw);
          if (f !== undefined) {
            return f;
          }
          try {
            const parent = current.parentElement();
            if (!(await parent.isExisting())) {
              break;
            }
            current = parent;
          } catch {
            break;
          }
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async isPepperLoginScreen(): Promise<boolean> {
    if (await this.isAnyVisible(PEPPER_PHONE_SELECTORS_STRICT, 1_200)) {
      return true;
    }
    if (await this.isAnyVisible(PEPPER_WELCOME_CONTINUE_SELECTORS, 900)) {
      return true;
    }
    return this.isAnyVisible(PEPPER_PASSWORD_SELECTORS, 900);
  }

  private async isPepperAuthenticatedAppScreen(): Promise<boolean> {
    if (await this.isPepperLoginScreen()) {
      return false;
    }
    if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 1_500)) {
      return true;
    }
    if (await this.isAnyVisible(PEPPER_LOGGED_IN_SELECTORS, 1_500)) {
      return true;
    }
    if (await this.isAnyVisible(PEPPER_PROFILE_SCREEN_SELECTORS, 1_500)) {
      return true;
    }
    return this.isAnyVisible(PEPPER_HOME_TAB_SELECTORS, 1_200);
  }

  /**
   * After a session snapshot load the app may reopen on profile or another sub-screen.
   * Return to the home dashboard before login checks or before saving a new snapshot.
   */
  private async ensurePepperSessionUiReady(): Promise<void> {
    await this.dismissNotificationPopupIfPresent();
    await sleep(900);

    if (await this.isPepperLoginScreen()) {
      // After force-stop relaunch, Pepper briefly shows the phone/login screen
      // before reading its auth token from AsyncStorage and navigating to home.
      // Wait to distinguish a transient startup state from a genuine login-required state.
      if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 8_000)) {
        // App navigated to home — fall through; snapshot will be saved on home screen
      } else {
        return;  // Still on login screen after grace period — needs re-authentication
      }
    }

    if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 2_000)) {
      return;
    }

    // Profile screen: the in-app back button has no accessible label — tap it now before
    // entering the slow recovery loop (saves ~2 minutes of fruitless back/home-tab attempts).
    if (await this.isAnyVisible(PEPPER_PROFILE_SCREEN_SELECTORS, 1_500)) {
      this.tapPepperProfileBackButton();
      await sleep(900);
      if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 3_000)) {
        return;
      }
    }

    this.stepLog('pepper.session.restore_ui', {});
    debug('Restoring Pepper UI to home (session snapshot may have opened off-dashboard)');

    for (let attempt = 0; attempt < 6; attempt++) {
      if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 1_400)) {
        return;
      }

      if (await this.isPepperLoginScreen()) {
        return;
      }

      // Profile screen may reappear (e.g. navigation state restoration) — tap back button.
      if (await this.isAnyVisible(PEPPER_PROFILE_SCREEN_SELECTORS, 800)) {
        this.tapPepperProfileBackButton();
        await sleep(800);
        continue;
      }

      if (await this.isAnyVisible(PEPPER_HOME_TAB_SELECTORS, 1_000)) {
        try {
          await this.tapAny(PEPPER_HOME_TAB_SELECTORS, 6_000);
          await sleep(700);
          if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 6_000)) {
            return;
          }
          // Home tab was tapped — don't press Back (would undo the navigation).
          // Next iteration will re-check the dashboard.
          continue;
        } catch {
          /* try back navigation next */
        }
      }

      await this.pressAndroidBack();
      await sleep(550);
    }

    try {
      await this.ensurePepperHomeDashboard();
    } catch (e) {
      debug(
        'ensurePepperHomeDashboard after session UI restore failed: %s',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  protected override async prepareEmulatorSnapshotState(): Promise<void> {
    // Close the app before saving the snapshot so the next run always starts
    // Pepper fresh via Appium — no stale navigation state to restore profile.
    this.spawnAdb(['am', 'force-stop', PACKAGE_NAME]);
    await sleep(600);
  }

  private async dismissWelcomeIfPresent(): Promise<void> {
    const hit = await this.isAnyVisible(PEPPER_WELCOME_CONTINUE_SELECTORS, 8_000);
    if (!hit) {
      return;
    }

    debug('Dismissing welcome / marketing screen');
    await this.tapAny(PEPPER_WELCOME_CONTINUE_SELECTORS, 22_000);
    await sleep(1800);
  }

  private async enterPhoneDigitsViaKeypad(digits: string): Promise<void> {
    const codes: Record<string, number> = {
      '0': 7,
      '1': 8,
      '2': 9,
      '3': 10,
      '4': 11,
      '5': 12,
      '6': 13,
      '7': 14,
      '8': 15,
      '9': 16,
    };

    const driverLike = this.driver as unknown as {
      pressKeyCode?: (code: number, metaState?: number) => Promise<void>;
    };

    if (typeof driverLike.pressKeyCode === 'function') {
      debug('Entering phone via Android keycodes (%d digits)', digits.length);
      try {
        for (const ch of digits) {
          const code = codes[ch];
          if (code !== undefined) {
            await driverLike.pressKeyCode(code);
          }
        }

        await sleep(700);
        return;
      } catch (e) {
        debug('pressKeyCode path failed: %s', e instanceof Error ? e.message : String(e));
      }
    }

    debug('Entering phone via on-screen keypad taps');
    for (const ch of digits) {
      await this.tapAny(
        [`//*[@text="${ch}" and (@clickable="true" or @focusable="true")]`, ua(`text("${ch}").clickable(true)`)],
        14_000,
      );

      await sleep(150);
    }
  }

  private async tapContinueOptional(visibleBudgetMs = 2_800): Promise<void> {
    const hit = await this.isAnyVisible(PEPPER_CONTINUE_SELECTORS, visibleBudgetMs);
    if (!hit) {
      return;
    }
    this.stepLog('pepper.login.tap_continue', {});
    await this.tapAny(PEPPER_CONTINUE_SELECTORS, 14_000);
    await sleep(450);
    await this.ensurePepperForegroundClosingForeignApps();
  }

  private async ensurePepperForegroundClosingForeignApps(maxPresses = 4): Promise<void> {
    for (let attempt = 0; attempt < maxPresses; attempt++) {
      const fg = await this.readForegroundPackage();
      this.stepLog('pepper.login.foreground', {
        package: fg.length > 0 ? fg : '(unknown)',
        attempt,
      });
      if (fg === PACKAGE_NAME) {
        return;
      }
      if (!fg) {
        return;
      }
      await this.pressAndroidBack();
      await sleep(700);
    }
  }

  private async waitForPasswordFieldResolvable(): Promise<void> {
    await this.ensurePepperForegroundClosingForeignApps();
    try {
      await this.waitForAnyDisplayed(PEPPER_PASSWORD_SELECTORS, 35_000);
      return;
    } catch (firstErr) {
      this.stepLog('pepper.password.wait_failed_once', {
        message: firstErr instanceof Error ? firstErr.message.slice(0, 240) : String(firstErr),
      });
      await this.pressAndroidBack();
      await sleep(550);
      await this.ensurePepperForegroundClosingForeignApps();
      await this.waitForAnyDisplayed(PEPPER_PASSWORD_SELECTORS, 28_000);
    }
  }

  private async isOtpPhaseVisible(): Promise<boolean> {
    if (await this.isAnyVisible(PEPPER_OTP_INPUT_SELECTORS, 550)) {
      return true;
    }
    return this.isAnyVisible(PEPPER_OTP_SCREEN_MARKERS, 550);
  }

  private async isLoginChromeVisible(): Promise<boolean> {
    if (await this.isAnyVisible(PEPPER_PASSWORD_SELECTORS, 450)) {
      return true;
    }
    return this.isAnyVisible(['//*[@text="כניסה לחשבון"]', ua('textContains("כניסה לחשבון")')], 450);
  }

  private async pollLoggedInOrOtpAfterPassword(totalMs: number): Promise<'logged_in' | 'otp'> {
    const deadline = Date.now() + totalMs;
    let blankCycles = 0;
    while (Date.now() < deadline) {
      // Check OTP first: it appears in milliseconds after the server validates credentials.
      // Checking it before the 23-selector logged-in list saves ~2 s per poll iteration.
      if (await this.isOtpPhaseVisible()) {
        return 'otp';
      }
      if (await this.isAnyVisible(PEPPER_LOGGED_IN_SELECTORS, 750)) {
        return 'logged_in';
      }
      // Terms page can appear after password submit when OTP is not required.
      if (await this.isAnyVisible(PEPPER_TERMS_SCREEN_SELECTORS, 450)) {
        this.stepLog('pepper.login.terms_after_password', {});
        await this.acceptTermsIfPresent(12_000);
        blankCycles = 0;
        continue;
      }
      if (await this.isLoginChromeVisible()) {
        await this.tapPostCredentialsSubmitOptional();
        blankCycles = 0;
        continue;
      }
      // After a few blank cycles, dismiss any system overlay (e.g. Google Password Manager)
      // that may be covering the OTP screen or home screen.
      blankCycles++;
      if (blankCycles % 3 === 0) {
        await this.ensurePepperForegroundClosingForeignApps();
      }
      await sleep(420);
    }
    throw new TimeoutError(`Timed out after ${totalMs}ms waiting for Pepper home screen or SMS/code verification UI`);
  }

  private async tapPostCredentialsSubmitOptional(visibleBudgetMs = 2_800): Promise<void> {
    const hit = await this.isAnyVisible(PEPPER_POST_CREDENTIALS_SUBMIT_SELECTORS, visibleBudgetMs);
    if (!hit) {
      return;
    }
    await this.tapAny(PEPPER_POST_CREDENTIALS_SUBMIT_SELECTORS, 14_000);
    await sleep(450);
  }

  private async tapVerifyOptional(): Promise<void> {
    const hit = await this.isAnyVisible(PEPPER_VERIFY_SELECTORS, 2_800);
    if (!hit) {
      debug('No OTP verify button found; assuming submit happens automatically');
      return;
    }
    await this.tapAny(PEPPER_VERIFY_SELECTORS, 14_000);
  }

  private phoneDigitsMatch(existingRaw: string, wantDialDigits: string): boolean {
    const a = existingRaw.replace(/\D/g, '');
    const b = wantDialDigits.replace(/\D/g, '');
    if (!b.length) {
      return false;
    }
    if (a === b) {
      return true;
    }
    if (a.length >= 9 && b.length >= 9) {
      const as = a.slice(-9);
      const bs = b.slice(-9);
      return as === bs || a.endsWith(bs) || b.endsWith(as);
    }
    return false;
  }

  private async readStrictPhoneFieldValue(): Promise<string> {
    for (const sel of PEPPER_PHONE_SELECTORS_STRICT) {
      try {
        const el = this.driver.$(sel);
        await el.waitForDisplayed({ timeout: 1_600 });
        const t = await el.getText();
        return typeof t === 'string' ? t : '';
      } catch {
        continue;
      }
    }
    return '';
  }

  private async enterPhoneStep(credentials: PepperCredentials): Promise<void> {
    const fullPhone = normalizePhone(credentials.phoneNumber);
    const dialDigits = digitsForDialerScreen(fullPhone);

    if (await this.isAnyVisible(PEPPER_PASSWORD_SELECTORS, 4_500)) {
      // Only skip phone entry if we're on the password-only step (two-step wizard).
      // On a combined phone+password form both fields are visible — don't skip.
      const phoneAlsoVisible = await this.isAnyVisible(PEPPER_PHONE_SELECTORS_STRICT, 1_500);
      if (!phoneAlsoVisible) {
        this.stepLog('pepper.login.skip_phone_password_visible', {});
        return;
      }
      this.stepLog('pepper.login.combined_form_detected', {});
    }

    const strictVisible = await this.isAnyVisible(PEPPER_PHONE_SELECTORS_STRICT, 11_000);
    if (strictVisible) {
      const existing = await this.readStrictPhoneFieldValue();
      if (this.phoneDigitsMatch(existing, dialDigits)) {
        this.stepLog('pepper.login.phone_prefilled_skip_type', {});
        return;
      }
      await this.typeIntoAny(PEPPER_PHONE_SELECTORS_STRICT, dialDigits, LOGIN_UI_WAIT_MS);
      return;
    }

    if (await this.isAnyVisible(PEPPER_PHONE_SELECTORS, 7_500)) {
      try {
        await this.typeIntoAny(PEPPER_PHONE_SELECTORS_STRICT, dialDigits, LOGIN_UI_WAIT_MS);
      } catch {
        this.stepLog('pepper.login.phone_strict_type_failed_keypad', {});
        await this.enterPhoneDigitsViaKeypad(dialDigits);
      }
      return;
    }

    await this.enterPhoneDigitsViaKeypad(dialDigits);
  }

  /**
   * Enters an OTP code into Pepper's custom React Native digit-box widget.
   *
   * Pepper's OTP screen uses ViewGroup elements (resource-id="otp-input") backed
   * by a hidden React Native TextInput. The keyboard is typically already open
   * and the first digit box is focused when this method is called.
   *
   * Strategy:
   *   1. If the system keyboard is already shown (the normal case), skip the tap
   *      entirely — tapping would close+reopen the keyboard and 400 ms is not
   *      enough time for the RN component to stabilise.
   *   2. If the keyboard is closed (e.g. dismissed by UiAutomator2 accessibility
   *      queries), tap accessible-rect-button to reopen it and wait 1000 ms.
   *   3. Send each digit as `adb shell input keyevent KEYCODE_<n>`.
   */
  private async enterPepperOtpCode(code: string): Promise<void> {
    debug('Entering OTP (%d digits)', code.length);

    for (const ch of code) {
      const n = ch.charCodeAt(0) - '0'.charCodeAt(0);
      if (n < 0 || n > 9) {
        throw new Error(`OTP contains non-digit character: ${JSON.stringify(ch)}`);
      }
    }

    // Check actual keyboard state.
    // If it is already open we go straight to typing — no tap needed.
    const keyboardOpen = this.isAndroidKeyboardShown();
    debug('OTP keyboard state: %s', keyboardOpen ? 'open' : 'closed');

    if (!keyboardOpen) {
      // Keyboard was closed (possibly dismissed by UiAutomator2 accessibility
      // queries). Tap the OTP input area to reopen it.
      const focusSelectors = [
        '//*[@resource-id="accessible-rect-button"]',
        '//*[@resource-id="otp-input"]',
        "//android.widget.EditText[contains(@resource-id,'otp')]",
        "//android.widget.EditText[contains(@resource-id,'Otp')]",
        '//android.widget.EditText',
      ];
      let tapped = false;
      for (const sel of focusSelectors) {
        try {
          const el = this.driver.$(sel);
          if (await el.isExisting()) {
            const loc = await el.getLocation();
            const sz = await el.getSize();
            const tapX = Math.round(loc.x + sz.width / 2);
            const tapY = Math.round(loc.y + sz.height / 2);
            debug('OTP focus tap: (%d, %d) via %s', tapX, tapY, sel);
            this.spawnAdb(['input', 'tap', String(tapX), String(tapY)]);
            tapped = true;
            break;
          }
        } catch (e) {
          debug('Focus selector %s failed: %s', sel, (e as Error)?.message);
        }
      }
      // Wait long enough for the keyboard animation and RN component to settle.
      await sleep(tapped ? 1000 : 400);
    } else {
      // Keyboard is open — the first digit box is already focused.
      // A short pause lets any pending UI animation finish.
      await sleep(300);
    }

    for (const ch of code) {
      const keycode = 7 + (ch.charCodeAt(0) - '0'.charCodeAt(0));
      this.spawnAdb(['input', 'keyevent', String(keycode)]);
      await sleep(80);
    }
    await sleep(500);
    debug('OTP digits sent');

    if (await this.isAnyVisible(PEPPER_PHONE_SELECTORS_STRICT, 600)) {
      throw new Error('After OTP entry we are back on the login screen — OTP entry was routed to the wrong field');
    }
  }

  private async dismissNotificationPopupIfPresent(): Promise<void> {
    if (!(await this.isAnyVisible(PEPPER_NOTIFICATION_POPUP_SELECTORS, 2_500))) {
      return;
    }
    debug('Notification opt-in popup detected; dismissing');
    await this.tapAny(PEPPER_NOTIFICATION_POPUP_DISMISS_SELECTORS, 8_000);
    await sleep(600);
  }

  private async acceptTermsIfPresent(timeoutMs = 8_000): Promise<void> {
    if (!(await this.isAnyVisible(PEPPER_TERMS_SCREEN_SELECTORS, timeoutMs))) {
      return;
    }
    debug('Terms of use screen detected; accepting');
    this.stepLog('pepper.login.terms_screen', {});

    // Check the checkbox ("I have read and agree to the terms…")
    const checkboxVisible = await this.isAnyVisible(PEPPER_TERMS_CHECKBOX_SELECTORS, 4_000);
    if (checkboxVisible) {
      await this.tapAny(PEPPER_TERMS_CHECKBOX_SELECTORS, 8_000);
      await sleep(600);
    }

    // Tap the agree button
    await this.tapAny(PEPPER_TERMS_AGREE_SELECTORS, 10_000);
    await sleep(1_200);
    debug('Terms accepted');
  }

  async login(credentials: PepperCredentials): Promise<ScraperLoginResult> {
    this.stepLog('pepper.login.start', {});

    if (!credentials.password?.trim()) {
      return {
        success: false,
        errorType: ScraperErrorTypes.Generic,
        errorMessage: 'Pepper login requires credentials.password.',
      };
    }

    await this.ensurePepperSessionUiReady();

    const loginFormVisible = await this.isPepperLoginScreen();

    if (!loginFormVisible) {
      debug('Login form not visible — checking if already logged in');
      if (await this.isPepperAuthenticatedAppScreen()) {
        await this.ensurePepperSessionUiReady();
        debug('Existing session found, skipping login');
        return { success: true };
      }
      // Terms page can be showing if the app was interrupted after OTP but before acceptance.
      if (await this.isAnyVisible(PEPPER_TERMS_SCREEN_SELECTORS, 3_000)) {
        this.stepLog('pepper.login.terms_at_start', {});
        debug('Terms page showing at session start; accepting and waiting for home');
        await this.acceptTermsIfPresent(12_000);
        await this.waitForAnyDisplayed(PEPPER_LOGGED_IN_SELECTORS, 30_000);
        return { success: true };
      }
      await sleep(1_500);
      await this.dismissWelcomeIfPresent();
    }

    this.stepLog('pepper.login.after_welcome', {});

    debug('Entering phone number');
    await this.enterPhoneStep(credentials);

    await this.dismissKeyboard();
    this.stepLog('pepper.login.after_phone', {});

    debug('Combined login: checking if password field is already on screen');
    const passwordAlreadyVisible = await this.isAnyVisible(PEPPER_PASSWORD_SELECTORS, 4_500);
    if (!passwordAlreadyVisible) {
      await this.tapContinueOptional(5_500);
    }

    debug('Waiting for password field');
    await this.waitForPasswordFieldResolvable();
    await this.typeIntoAny(PEPPER_PASSWORD_SELECTORS, credentials.password.trim(), LOGIN_UI_WAIT_MS);
    await this.dismissKeyboard();
    await sleep(1_100);

    // Google Password Manager and other autofill overlays can appear after password entry,
    // covering the OTP screen or the sign-in button. Dismiss before checking app state.
    await this.ensurePepperForegroundClosingForeignApps();

    // Check OTP first (server often auto-triggers it the moment valid credentials are typed),
    // then home screen, then sign-in button — in order from most likely to least likely.
    if (await this.isOtpPhaseVisible()) {
      debug('OTP screen visible immediately after password entry');
    } else if (await this.isAnyVisible(PEPPER_LOGGED_IN_SELECTORS, 3_000)) {
      debug('Already on Pepper home; skipping כניסה לחשבון tap');
    } else {
      try {
        await this.tapAny(PEPPER_POST_CREDENTIALS_SUBMIT_SELECTORS, 14_000);
      } catch (e) {
        // Overlay may have appeared during the tap attempt — dismiss and recheck.
        await this.ensurePepperForegroundClosingForeignApps();
        await sleep(500);
        if (await this.isOtpPhaseVisible()) {
          debug('OTP appeared (was obscured by overlay)');
        } else if (await this.isAnyVisible(PEPPER_LOGGED_IN_SELECTORS, 3_000)) {
          debug('Home visible after sign-in button timeout — continuing');
        } else {
          throw e;
        }
      }
    }

    debug('Waiting for home or optional SMS/code step');
    const afterPassword = await this.pollLoggedInOrOtpAfterPassword(48_000);

    if (afterPassword === 'logged_in') {
      debug('Logged in without SMS/code verification step');
      return { success: true };
    }

    if (!credentials.otpCodeRetriever) {
      return {
        success: false,
        errorType: ScraperErrorTypes.TwoFactorRetrieverMissing,
        errorMessage: 'Pepper is asking for SMS/code verification. Provide otpCodeRetriever to supply the code.',
      };
    }

    await this.waitForAnyDisplayed(PEPPER_OTP_INPUT_SELECTORS, 10_000);
    debug('SMS/code verification required; invoking otpCodeRetriever');
    const otpCode = await credentials.otpCodeRetriever();

    await this.enterPepperOtpCode(otpCode);
    await this.tapVerifyOptional();

    // One-time terms-of-use acceptance screen that appears after first OTP verification.
    await this.acceptTermsIfPresent(8_000);

    debug('Waiting for home screen after OTP');
    await this.waitForAnyDisplayed(PEPPER_LOGGED_IN_SELECTORS, 45_000);

    return { success: true };
  }

  private async readBalanceFromHeroCompound(): Promise<number | undefined> {
    for (const sel of PEPPER_HERO_BALANCE_COMPOUND_SELECTORS) {
      try {
        const el = this.driver.$(sel);
        await el.waitForDisplayed({ timeout: 5_000 });
        const raw = await this.readAccessibleText(el);
        const n = firstIlsAmountFromCompoundText(raw);
        if (n !== undefined) {
          return n;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async readBalance(): Promise<number> {
    const scanEarly = await this.readBalanceFromShekelElementsScan();
    if (scanEarly !== undefined) {
      return scanEarly;
    }

    const fromWalk = await this.readBalanceFromWalkAncestorsFromLabels();
    if (fromWalk !== undefined) {
      return fromWalk;
    }

    const hero = await this.dashboardIlsAfterLabelNth('זאת היתרה', 1);
    if (hero !== undefined) {
      return hero;
    }

    const compound = await this.readBalanceFromHeroCompound();
    if (compound !== undefined) {
      return compound;
    }

    const el = await this.waitForAnyDisplayed(PEPPER_BALANCE_SELECTORS, 18_000);
    const raw = await this.readAccessibleText(el);
    const parsed = parseCurrencyAmountSnippet(raw);
    if (parsed?.currency === 'ILS' && Number.isFinite(parsed.amount)) {
      return parsed.amount;
    }
    const fromCompound = firstIlsAmountFromCompoundText(raw);
    if (fromCompound !== undefined) {
      return fromCompound;
    }
    const cleaned = raw.replace(AMOUNT_STRIP_REGEX, '').trim();
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) {
      return n;
    }

    throw new Error('Could not parse Pepper balance from UI');
  }

  private async ensurePepperHomeDashboard(): Promise<void> {
    debug('Ensuring Pepper בית dashboard before reads');
    await this.dismissNotificationPopupIfPresent();
    try {
      await this.tapAny(PEPPER_HOME_TAB_SELECTORS, 22_000);
    } catch {
      debug('Home tab tap skipped or failed; continuing to wait for dashboard');
    }
    await sleep(700);
    await this.waitForAnyDisplayed(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 5_000);
  }

  private async dashboardIlsNearLabelWalk(labelNeedle: string): Promise<number | undefined> {
    const sel = `//*[contains(@text,"${labelNeedle}") or contains(@content-desc,"${labelNeedle}")]`;
    try {
      let el = this.driver.$(sel);
      if (!(await el.isExisting())) {
        return undefined;
      }
      for (let d = 0; d < 9; d++) {
        const raw = await this.readAccessibleText(el);
        const p = parseCurrencyAmountSnippet(raw);
        if (p?.currency === 'ILS' && Number.isFinite(p.amount)) {
          return p.amount;
        }
        const f = firstIlsAmountFromCompoundText(raw);
        if (f !== undefined) {
          return f;
        }
        try {
          const kids = await el.$$('.//android.widget.TextView | .//android.view.View').getElements();
          for (const ch of kids.slice(0, 24)) {
            try {
              const cr = await this.readAccessibleText(ch);
              const cp = parseCurrencyAmountSnippet(cr);
              if (cp?.currency === 'ILS' && Number.isFinite(cp.amount)) {
                return cp.amount;
              }
              const cf = firstIlsAmountFromCompoundText(cr);
              if (cf !== undefined) {
                return cf;
              }
            } catch {}
          }
        } catch {}
        try {
          const parent = el.parentElement();
          if (!(await parent.isExisting())) {
            break;
          }
          el = parent;
        } catch {
          break;
        }
      }
    } catch (e) {
      debug('dashboardIlsNearLabelWalk(%s) failed: %s', labelNeedle, e instanceof Error ? e.message : String(e));
      return undefined;
    }
    return undefined;
  }

  private async dashboardIlsAfterLabelNth(labelNeedle: string, nth: number): Promise<number | undefined> {
    try {
      const labelPred = `contains(@text,"${labelNeedle}") or contains(@content-desc,"${labelNeedle}")`;
      const shekelPred =
        "contains(@text,'₪') or contains(@text,'\\u20aa') or contains(@content-desc,'₪') or contains(@content-desc,'\\u20aa')";
      const sel = `//*[${labelPred}]/following::*[${shekelPred}][${nth}]`;
      const el = this.driver.$(sel);
      if (!(await Promise.resolve(el.isExisting()))) {
        return undefined;
      }
      const raw = await this.readAccessibleText(el);
      const parsed = parseCurrencyAmountSnippet(raw);
      if (!parsed || parsed.currency !== 'ILS' || !Number.isFinite(parsed.amount)) {
        return undefined;
      }
      return parsed.amount;
    } catch (e) {
      debug(
        'dashboardIlsAfterLabelNth(%s,%d) failed: %s',
        labelNeedle,
        nth,
        e instanceof Error ? e.message : String(e),
      );
      return undefined;
    }
  }

  private async dashboardForeignBalances(): Promise<CurrencyAmount[] | undefined> {
    const pivotXpaths = [
      '//*[contains(@text,"מט\u05f4ח") or contains(@content-desc,"מט\u05f4ח")]',
      "//*[contains(@text,'מט\"ח') or contains(@content-desc,'מט\"ח')]",
      '//*[contains(@text,"מטח") or contains(@content-desc,"מטח")]',
    ];
    const pivotUi = [
      ua('textContains("מט\u05f4ח")'),
      ua('textContains("מטח")'),
      ua('descriptionContains("מט\u05f4ח")'),
      ua('descriptionContains("מטח")'),
    ];

    const stops = /כרטיסי אשראי|תנועות אחרונות|פעולות|^בית$/;

    for (const px of [...pivotXpaths, ...pivotUi]) {
      try {
        const anchor = this.driver.$(px);
        if (!(await Promise.resolve(anchor.isExisting()))) {
          continue;
        }

        const gather: CurrencyAmount[] = [];
        let elWalker = anchor;

        for (let depth = 0; depth < 5; depth++) {
          const blob = await this.readAccessibleText(elWalker);
          mergeForeignAmounts(gather, extractForeignCurrencyAmountsFromText(blob));
          if (gather.length >= 6) {
            break;
          }
          try {
            const p = elWalker.parentElement();
            if (!(await p.isExisting())) {
              break;
            }
            elWalker = p;
          } catch {
            break;
          }
        }

        try {
          const followingEls = await anchor.$$('xpath=following::android.widget.TextView').getElements();
          for (let i = 0; i < Math.min(28, followingEls.length); i++) {
            const node = followingEls[i];
            const raw = await this.readAccessibleText(node);
            if (!raw) {
              continue;
            }
            const line = stripBidiAndTrim(raw);
            if (stops.exec(line)) {
              break;
            }
            mergeForeignAmounts(gather, extractForeignCurrencyAmountsFromText(raw));
            if (gather.length >= 6) {
              break;
            }
          }
        } catch {}

        try {
          const rowish = await anchor.$$('.//android.widget.TextView | .//android.view.View').getElements();
          for (const node of rowish.slice(0, 20)) {
            const raw = await this.readAccessibleText(node);
            mergeForeignAmounts(gather, extractForeignCurrencyAmountsFromText(raw));
            if (gather.length >= 6) {
              break;
            }
          }
        } catch {}

        if (gather.length > 0) {
          return gather;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  private async dashboardForeignBalancesBroadScan(): Promise<CurrencyAmount[] | undefined> {
    const fxHint = /[$€£¥]|מט\u05f4ח|מט["׳']ח|\bUSD\b|\bEUR\b|\bGBP\b|\bCHF\b|\bJPY\b|\bCAD\b|\bAUD\b|\bPLN\b/i;
    try {
      const size = await this.driver.getWindowSize().catch(() => ({ height: 2400 }));
      const yLimit = Math.min(Math.round(size.height * 0.94), 3200);
      const gather: CurrencyAmount[] = [];
      const xpath =
        '//android.widget.TextView | //android.view.View | //android.widget.Button | //*[@clickable="true"]';
      const els = await this.driver.$$(xpath).getElements();
      let seen = 0;
      for (const el of els) {
        if (seen >= 320) {
          break;
        }
        seen++;
        try {
          if (!(await el.isDisplayed())) {
            continue;
          }
          const loc = await el.getLocation().catch(() => ({ y: 99999 }));
          if (loc.y > yLimit) {
            continue;
          }
          const raw = await this.readAccessibleText(el);
          if (!raw || raw.length > 520) {
            continue;
          }
          if (!fxHint.test(raw)) {
            continue;
          }
          mergeForeignAmounts(gather, extractForeignCurrencyAmountsFromText(raw));
          if (gather.length >= 14) {
            break;
          }
        } catch {
          continue;
        }
      }
      return gather.length > 0 ? gather : undefined;
    } catch (e) {
      debug('dashboardForeignBalancesBroadScan failed: %s', e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }

  private async readPepperAccountTotals(): Promise<AccountTotals | undefined> {
    const totals: AccountTotals = {};

    try {
      const savings =
        (await this.dashboardIlsNearLabelWalk('חסכונות')) ?? (await this.dashboardIlsAfterLabelNth('חסכונות', 1));
      if (savings !== undefined) {
        totals.savings = savings;
      }
    } catch {}

    try {
      const investments =
        (await this.dashboardIlsNearLabelWalk('תיק השקעות')) ??
        (await this.dashboardIlsNearLabelWalk('תיק ההשקעות')) ??
        (await this.dashboardIlsAfterLabelNth('תיק השקעות', 1)) ??
        (await this.dashboardIlsAfterLabelNth('תיק ההשקעות', 1));
      if (investments !== undefined) {
        totals.investments = investments;
      }
    } catch {}

    let fx: CurrencyAmount[] | undefined;
    try {
      fx = await this.dashboardForeignBalances();
    } catch {}
    if (!fx || fx.length === 0) {
      try {
        fx = await this.dashboardForeignBalancesBroadScan();
      } catch {}
    }
    if (fx && fx.length > 0) {
      totals.foreignCurrency = fx;
    }

    return Object.keys(totals).length > 0 ? totals : undefined;
  }

  private async openPepperProfileFromHome(): Promise<void> {
    await this.driver
      .action('pointer')
      .move({ duration: 0, x: 575, y: 291 })
      .down({ button: 0 })
      .pause(50)
      .up({ button: 0 })
      .perform();

    return;
  }

  /**
   * Tap the in-app back button on the Pepper profile/account screen.
   *
   * The button (RTL '>' chevron, top-right of screen) has no text or content-desc,
   * so it cannot be found by UiSelector or XPath. Coordinates are derived from a
   * uiautomator dump: bounds=[1112,471][1232,591] on a 1280×2856 screen (91.6% / 18.6%).
   */
  private tapPepperProfileBackButton(): void {
    this.stepLog('pepper.session.profile_back', {});
    // Back button has no accessible label (rid='pressable', content-desc='', text='').
    // Confirmed coords from uiautomator dump: bounds=[1112,471][1232,591] on 1280×2856.
    this.spawnAdb(['input', 'tap', '1172', '531']);
  }

  private async readAccountNumberFromProfileClipboard(): Promise<string | undefined> {
    await this.ensurePepperHomeDashboard();
    try {
      await this.openPepperProfileFromHome();
    } catch (e) {
      debug('openPepperProfileFromHome: %s', e instanceof Error ? e.message : String(e));
      // Profile navigation may have partially started; ensure we're back on home.
      await this.ensurePepperSessionUiReady().catch(() => undefined);
      return undefined;
    }

    await this.driver.pause(300);
    try {
      await this.driver
        .action('pointer')
        .move({ duration: 0, x: 78, y: 739 })
        .down({ button: 0 })
        .pause(50)
        .up({ button: 0 })
        .perform();
    } catch (e) {
      debug('pepper profile copy control: %s', e instanceof Error ? e.message : String(e));
      this.spawnAdb(['am', 'force-stop', PACKAGE_NAME]);
      return undefined;
    }

    const clip = await this.readAndroidClipboardPlaintext();
    // Close the app — navigation back from the profile page is unreliable.
    // prepareEmulatorSnapshotState will save the snapshot with Pepper closed;
    // on the next run Appium launches it fresh at the login/home screen.
    this.spawnAdb(['am', 'force-stop', PACKAGE_NAME]);
    if (!clip) {
      return undefined;
    }
    const stripped = stripBidiAndTrim(clip);
    let normalized = normalizePepperAccountNumber(stripped);
    if (this.isLikelyPepperAccountToken(normalized)) {
      return normalized;
    }
    const acctLine = stripped.match(/חשבון[^\n]*/u);
    if (acctLine) {
      normalized = normalizePepperAccountNumber(acctLine[0]);
      if (this.isLikelyPepperAccountToken(normalized)) {
        return normalized;
      }
    }
    const dashed = stripped.match(/\b\d{1,3}-\d{1,3}-[\d*•-]{3,}\b/u);
    if (dashed) {
      normalized = normalizePepperAccountNumber(dashed[0]);
      if (this.isLikelyPepperAccountToken(normalized)) {
        return normalized;
      }
    }
    const digits = stripped.replace(/\D/g, '');
    if (digits.length >= 6 && digits.length <= 14 && this.isLikelyPepperAccountToken(digits)) {
      return digits;
    }
    return undefined;
  }

  private isLikelyPepperAccountToken(normalized: string): boolean {
    const compact = normalized.replace(/\s/g, '');
    if (/^\d{4,14}$/.test(compact)) {
      return true;
    }
    if (/^\d{1,3}-\d{1,3}-\d{3,}$/.test(compact)) {
      return true;
    }
    if (/^\d{1,3}-\d{1,3}-[\d*•]{3,}$/.test(compact)) {
      const digits = compact.replace(/\D/g, '');
      return digits.length >= 4;
    }
    return false;
  }

  private async readAccountNumber(): Promise<string> {
    const fromProfile = await this.readAccountNumberFromProfileClipboard();
    if (fromProfile && fromProfile.length > 0) {
      return fromProfile;
    }
    return 'unknown';
  }

  async probePepperDashboard(): Promise<PepperDashboardProbeResult> {
    await this.ensurePepperHomeDashboard();
    const sels: { name: string; sel: string }[] = [
      { name: 'heroBalanceLabel', sel: ua('textContains("זאת היתרה")') },
      { name: 'accountTextMarker', sel: '//*[contains(@text,"חשבון") or contains(@content-desc,"חשבון")]' },
    ];
    const homeMarkers: PepperDashboardProbeResult['homeMarkers'] = [];
    for (const { name, sel } of sels) {
      try {
        const el = this.driver.$(sel);
        const exists = await el.isExisting();
        let displayed = false;
        let accessibleTextPreview = '';
        if (exists) {
          try {
            displayed = await el.isDisplayed();
          } catch {}
          if (displayed) {
            accessibleTextPreview = (await this.readAccessibleText(el)).slice(0, 240);
          }
        }
        homeMarkers.push({ name, exists, displayed, accessibleTextPreview });
      } catch {
        homeMarkers.push({ name, exists: false, displayed: false, accessibleTextPreview: '' });
      }
    }

    const shekelXPath =
      '//*[contains(@text,"₪") or contains(@text,"\u20aa") or contains(@content-desc,"₪") or contains(@content-desc,"\u20aa")]';
    let shekelMatchingNodeCount = 0;
    const topShekelSamples: PepperDashboardProbeResult['topShekelSamples'] = [];
    try {
      const shekelEls = await this.driver.$$(shekelXPath).getElements();
      shekelMatchingNodeCount = shekelEls.length;
      for (const el of shekelEls) {
        try {
          if (!(await el.isDisplayed())) {
            continue;
          }
          const loc = await el.getLocation().catch(() => ({ x: 0, y: 0 }));
          const accessibleText = (await this.readAccessibleText(el)).slice(0, 200);
          topShekelSamples.push({ y: loc.y, accessibleText });
        } catch {}
      }
      topShekelSamples.sort((a, b) => a.y - b.y);
    } catch {}

    const balanceAttempts: PepperDashboardProbeResult['balanceAttempts'] = [];

    const tryPath = async (path: string, fn: () => Promise<number | undefined>) => {
      try {
        const value = await fn();
        if (value !== undefined) {
          balanceAttempts.push({ path, value });
        } else {
          balanceAttempts.push({ path, error: 'undefined' });
        }
      } catch (e) {
        balanceAttempts.push({ path, error: e instanceof Error ? e.message : String(e) });
      }
    };

    await tryPath('readBalanceFromWalkAncestorsFromLabels', () => this.readBalanceFromWalkAncestorsFromLabels());
    await tryPath('dashboardIlsAfterLabelNth_זאת_היתרה', () => this.dashboardIlsAfterLabelNth('זאת היתרה', 1));
    await tryPath('readBalanceFromHeroCompound', () => this.readBalanceFromHeroCompound());
    await tryPath('readBalanceFromShekelElementsScan', () => this.readBalanceFromShekelElementsScan());

    let foreignPivotScanCount = 0;
    try {
      const pivoted = await this.dashboardForeignBalances();
      foreignPivotScanCount = pivoted?.length ?? 0;
    } catch {}
    const foreignBroad = await this.dashboardForeignBalancesBroadScan();
    const foreignBroadScanCount = foreignBroad?.length ?? 0;

    return {
      homeMarkers,
      shekelMatchingNodeCount,
      topShekelSamples: topShekelSamples.slice(0, 18),
      balanceAttempts,
      foreignPivotScanCount,
      foreignBroadScanCount,
      foreignBroadScanPreview: foreignBroad?.slice(0, 8).map(c => `${c.currency}:${c.amount}`),
    };
  }

  async runProbeSession(credentials: PepperCredentials): Promise<PepperDashboardProbeResult> {
    await this.initialize();
    const loginResult = await this.login(credentials);
    if (!loginResult.success) {
      await this.terminate(false);
      throw new Error(loginResult.errorMessage ?? 'Pepper login failed');
    }
    const probe = await this.probePepperDashboard();
    await this.terminate(true);
    return probe;
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    debug('Reading account info');

    await this.ensurePepperHomeDashboard();

    let accountTotals: AccountTotals | undefined;
    try {
      accountTotals = await this.readPepperAccountTotals();
    } catch (e) {
      accountTotals = undefined;
      debug('readPepperAccountTotals failed: %s', e instanceof Error ? e.message : String(e));
    }

    let balance: number | undefined;
    try {
      balance = await this.readBalance();
    } catch (e) {
      balance = undefined;
      debug('readBalance failed: %s', e instanceof Error ? e.message : String(e));
    }

    let accountNumber: string;
    try {
      accountNumber = await this.readAccountNumber();
    } catch (e) {
      accountNumber = 'unknown';
      debug('readAccountNumber failed: %s', e instanceof Error ? e.message : String(e));
    }

    const safeAccountNumber = accountNumber.length > 0 ? accountNumber : 'unknown';
    const account: TransactionsAccount = {
      ...accountTotals,
      accountNumber: safeAccountNumber,
      balance,
      txns: [],
    };

    return { success: true, accounts: [account] };
  }
}
