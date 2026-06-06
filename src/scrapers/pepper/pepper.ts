import { getDebug } from '../../helpers/debug';
import { sleep } from '../../helpers/waiting';
import { stripBidirectionalAndTrim } from '../../helpers/text';
import { type CurrencyAmount, type TransactionsAccount } from '../../transactions';
import { BaseAndroidAppScraper } from '../base-android-app-scraper';
import { ScraperErrorTypes } from '../errors';
import { type ScraperLoginResult, type ScraperScrapingResult } from '../interface';
import {
  dedupeCurrencyAmounts,
  extractForeignCurrencyAmountsFromText,
  firstIlsAmountFromCompoundText,
  isLikelyPepperAccountToken,
  normalizePepperAccountNumber,
  parseCurrencyAmountSnippet,
  toIsraeliDialerDigits,
  toIsraeliE164Phone,
} from './pepper-parsing';
import {
  PEPPER_AUTOFILL_DISMISS_SELECTORS,
  PEPPER_ACCOUNT_LINE_REGEX,
  PEPPER_BALANCE_AMOUNT_STRIP_REGEX,
  PEPPER_BALANCE_SELECTORS,
  PEPPER_DASHED_ACCOUNT_TOKEN_REGEX,
  PEPPER_FOREIGN_CURRENCY_HINT_REGEX,
  PEPPER_FOREIGN_CURRENCY_NODE_SELECTOR,
  PEPPER_HOME_DASHBOARD_READY_SELECTORS,
  PEPPER_INVALID_CREDENTIALS_SCREEN_SELECTORS,
  PEPPER_NOTIFICATION_POPUP_DISMISS_SELECTORS,
  PEPPER_NOTIFICATION_POPUP_SELECTORS,
  PEPPER_OTP_FOCUS_SELECTORS,
  PEPPER_OTP_WAIT_SELECTORS,
  PEPPER_PACKAGE_NAME,
  PEPPER_PASSWORD_SELECTORS,
  PEPPER_PHONE_SELECTORS_STRICT,
  PEPPER_PROFILE_COORDINATES,
  PEPPER_PROFILE_SCREEN_SELECTORS,
  PEPPER_SHEKEL_NODE_SELECTOR,
  PEPPER_SHEKEL_PREDICATE,
  PEPPER_TERMS_AGREE_SELECTORS,
  PEPPER_TERMS_CHECKBOX_SELECTORS,
  PEPPER_TERMS_SCREEN_SELECTORS,
  PEPPER_VERIFY_SELECTORS,
  PEPPER_WELCOME_CONTINUE_SELECTORS,
} from './pepper-selectors';
import { type PepperAccountTotals, type PepperCredentials } from './pepper-types';

const debug = getDebug('pepper');

const UI_WAIT_MS = 12_000;
const LOGIN_OUTCOME_MS = 30_000;

type PepperUiElement = {
  getText: () => Promise<string>;
  getAttribute: (name: string) => Promise<string | null>;
  isDisplayed: () => Promise<boolean>;
  isExisting: () => Promise<boolean>;
  getLocation: () => Promise<{ x: number; y: number }>;
  getSize: () => Promise<{ width: number; height: number }>;
};

type LoginOutcome = 'home' | 'otp' | 'invalid_creds';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Pepper scraper — static login flow for a dedicated emulator snapshot.
 *
 * Baseline snapshot: welcome → combined phone+password (auto-advances) → OTP → terms → home.
 * Session snapshot: home dashboard already visible → skip login.
 */
export default class PepperScraper extends BaseAndroidAppScraper<PepperCredentials> {
  get appPackage(): string {
    return PEPPER_PACKAGE_NAME;
  }

  protected override async prepareEmulatorSnapshotState(): Promise<void> {
    this.spawnAdb(['am', 'force-stop', PEPPER_PACKAGE_NAME]);
    await sleep(400);
  }

  async login(credentials: PepperCredentials): Promise<ScraperLoginResult> {
    if (!credentials.password?.trim()) {
      return {
        success: false,
        errorType: ScraperErrorTypes.Generic,
        errorMessage: 'Pepper login requires credentials.password.',
      };
    }

    this.stepLog('pepper.login.start', {});

    if (await this.isAnyDisplayed(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 2_000)) {
      debug('Already on home dashboard; skipping login');
      await this.dismissNotificationPopup();
      return { success: true };
    }

    await this.dismissNotificationPopup();
    await this.openLoginForm();
    this.stepLog('pepper.login.after_welcome', {});

    const dialDigits = toIsraeliDialerDigits(toIsraeliE164Phone(credentials.phoneNumber));
    await this.typeIntoFirst(PEPPER_PHONE_SELECTORS_STRICT, dialDigits, UI_WAIT_MS);
    this.stepLog('pepper.login.after_phone', {});

    await this.typeIntoFirst(PEPPER_PASSWORD_SELECTORS, credentials.password.trim(), UI_WAIT_MS);
    this.stepLog('pepper.login.after_password', {});
    await this.dismissAutofillOverlay();

    const outcome = await this.waitForLoginOutcome(LOGIN_OUTCOME_MS);
    if (outcome === 'home') {
      return { success: true };
    }
    if (outcome === 'invalid_creds') {
      this.stepLog('pepper.login.invalid_credentials', {});
      return {
        success: false,
        errorType: ScraperErrorTypes.InvalidPassword,
        errorMessage: 'Login failed with INVALID_PASSWORD error',
      };
    }

    return this.completeOtpStep(credentials);
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    debug('Reading account info');
    await this.dismissNotificationPopup();
    await this.dismissAutofillOverlay();

    const accountTotals = await this.readAccountTotalsSafely();
    const balance = await this.readBalanceSafely();
    const accountNumber = await this.readAccountNumberSafely();

    return {
      success: true,
      accounts: [{ ...accountTotals, accountNumber, balance, txns: [] } satisfies TransactionsAccount],
    };
  }

  // ---------------------------------------------------------------------------
  // Static login flow
  // ---------------------------------------------------------------------------

  /**
   * Fresh install / baseline snapshot: Pepper opens on a marketing screen with
   * "כניסה לחשבון שלי". Wait for that button or the login form, then tap through.
   */
  private async openLoginForm(): Promise<void> {
    const deadline = Date.now() + UI_WAIT_MS;
    while (Date.now() < deadline) {
      if (await this.isAnyDisplayed(PEPPER_PHONE_SELECTORS_STRICT)) {
        debug('Login form already visible');
        return;
      }
      if (await this.isAnyDisplayed(PEPPER_WELCOME_CONTINUE_SELECTORS)) {
        debug('Tapping "כניסה לחשבון שלי"');
        this.stepLog('pepper.login.welcome_tap', {});
        await this.tapFirst(PEPPER_WELCOME_CONTINUE_SELECTORS, UI_WAIT_MS);
        await this.waitForFirst(PEPPER_PHONE_SELECTORS_STRICT, UI_WAIT_MS);
        return;
      }
      await sleep(200);
    }
    throw new Error(
      'Neither the "כניסה לחשבון שלי" welcome button nor the phone login field appeared in time',
    );
  }

  private async waitForLoginOutcome(timeoutMs: number): Promise<LoginOutcome> {
    this.stepLog('pepper.login.await_outcome', {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of PEPPER_OTP_WAIT_SELECTORS) {
        if (await this.isDisplayed(selector)) {
          return 'otp';
        }
      }
      if (await this.isAnyDisplayed(PEPPER_INVALID_CREDENTIALS_SCREEN_SELECTORS)) {
        return 'invalid_creds';
      }
      if (await this.isAnyDisplayed(PEPPER_HOME_DASHBOARD_READY_SELECTORS)) {
        return 'home';
      }
      await sleep(200);
    }
    throw new Error(`Login outcome not reached within ${timeoutMs}ms`);
  }

  private async completeOtpStep(credentials: PepperCredentials): Promise<ScraperLoginResult> {
    if (!credentials.otpCodeRetriever) {
      return {
        success: false,
        errorType: ScraperErrorTypes.TwoFactorRetrieverMissing,
        errorMessage: 'Pepper is asking for SMS/code verification. Provide otpCodeRetriever to supply the code.',
      };
    }

    this.stepLog('pepper.login.otp', {});
    debug('Invoking otpCodeRetriever');
    const otpCode = await credentials.otpCodeRetriever();

    // Re-confirm OTP screen after user input — do not activateApp (that relaunches and drops OTP state).
    await this.waitForFirst(PEPPER_OTP_WAIT_SELECTORS, UI_WAIT_MS);
    await this.enterOtpCode(otpCode);
    await this.tapVerifyIfPresent();

    await this.acceptTerms();
    await this.waitForFirst(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 45_000);
    return { success: true };
  }

  /**
   * Enter OTP into Pepper's custom React Native digit-box widget.
   * UiAutomator queries can dismiss the keyboard — tap the input to reopen it, then adb keyevents.
   */
  private async enterOtpCode(code: string): Promise<void> {
    debug('Entering OTP (%d digits)', code.length);
    if (!/^\d+$/.test(code)) {
      throw new Error(`OTP must contain only digits, received ${JSON.stringify(code)}`);
    }

    if (!this.isAndroidKeyboardShown()) {
      await this.focusOtpInput();
      await this.waitForCondition(() => Promise.resolve(this.isAndroidKeyboardShown()), {
        timeoutMs: 1_500,
        intervalMs: 150,
      });
    }

    await this.pressDigitsViaAdbKeyevent(code);
    this.stepLog('pepper.login.otp_entered', {});

    if (await this.isAnyDisplayed(PEPPER_PHONE_SELECTORS_STRICT)) {
      throw new Error('After OTP entry the login screen is showing again — OTP was routed to the wrong field');
    }
  }

  private async focusOtpInput(): Promise<void> {
    for (const selector of PEPPER_OTP_FOCUS_SELECTORS) {
      try {
        const element = this.element(selector);
        if (!(await element.isExisting())) {
          continue;
        }
        const location = await element.getLocation();
        const size = await element.getSize();
        this.tapByCoordinates(location.x + size.width / 2, location.y + size.height / 2);
        return;
      } catch (error) {
        debug('OTP focus selector %s failed: %s', selector, errorMessage(error));
      }
    }
    throw new Error('Could not focus Pepper OTP input');
  }

  private async tapVerifyIfPresent(): Promise<void> {
    if (!(await this.isAnyDisplayed(PEPPER_VERIFY_SELECTORS))) {
      debug('No OTP verify button found; assuming submit happens automatically');
      return;
    }
    await this.tapFirst(PEPPER_VERIFY_SELECTORS, UI_WAIT_MS);
  }

  /** Dismiss Google Password Manager or other system overlays covering Pepper. */
  private async dismissAutofillOverlay(): Promise<void> {
    if (await this.isAnyDisplayed(PEPPER_AUTOFILL_DISMISS_SELECTORS)) {
      debug('Dismissing autofill / password manager prompt');
      this.stepLog('pepper.login.dismiss_autofill', {});
      await this.tapFirst(PEPPER_AUTOFILL_DISMISS_SELECTORS, 4_000);
      return;
    }

    const foregroundPackage = await this.readCurrentPackage();
    if (foregroundPackage && foregroundPackage !== PEPPER_PACKAGE_NAME) {
      debug('Pressing back to return to Pepper (foreground was %s)', foregroundPackage);
      this.stepLog('pepper.login.foreground_back', { package: foregroundPackage });
      await this.pressAndroidBack();
    }
  }

  private async dismissNotificationPopup(): Promise<void> {
    if (!(await this.isAnyDisplayed(PEPPER_NOTIFICATION_POPUP_SELECTORS))) {
      return;
    }
    debug('Dismissing notification opt-in popup');
    await this.tapFirst(PEPPER_NOTIFICATION_POPUP_DISMISS_SELECTORS, UI_WAIT_MS);
  }

  private async acceptTerms(): Promise<void> {
    if (!(await this.isAnyDisplayed(PEPPER_TERMS_SCREEN_SELECTORS))) {
      return;
    }
    debug('Accepting terms of use');
    this.stepLog('pepper.login.terms_screen', {});
    if (await this.isAnyDisplayed(PEPPER_TERMS_CHECKBOX_SELECTORS)) {
      await this.tapFirst(PEPPER_TERMS_CHECKBOX_SELECTORS, UI_WAIT_MS);
    }
    await this.tapFirst(PEPPER_TERMS_AGREE_SELECTORS, UI_WAIT_MS);
  }

  // ---------------------------------------------------------------------------
  // Data reads
  // ---------------------------------------------------------------------------

  private element(selector: string): PepperUiElement {
    return this.driver.$(selector) as unknown as PepperUiElement;
  }

  private async queryElements(selector: string): Promise<PepperUiElement[]> {
    return (await this.driver.$$(selector).getElements().catch(() => [])) as unknown as PepperUiElement[];
  }

  private async ilsAmountAfterLabel(label: string, nth: number): Promise<number | undefined> {
    const labelPredicate = `contains(@text,"${label}") or contains(@content-desc,"${label}")`;
    const selector = `//*[${labelPredicate}]/following::*[${PEPPER_SHEKEL_PREDICATE}][${nth}]`;
    const el = this.element(selector);
    if (!(await el.isExisting().catch(() => false))) {
      return undefined;
    }
    const parsed = parseCurrencyAmountSnippet(await this.readAccessibleText(el));
    return parsed?.currency === 'ILS' && Number.isFinite(parsed.amount) ? parsed.amount : undefined;
  }

  private async ilsAmountFromShekelNodes(): Promise<number | undefined> {
    const elements = await this.queryElements(PEPPER_SHEKEL_NODE_SELECTOR);
    const candidates: { amount: number; y: number }[] = [];
    for (const el of elements) {
      try {
        if (!(await el.isDisplayed())) {
          continue;
        }
        const parsed = parseCurrencyAmountSnippet(await this.readAccessibleText(el));
        if (parsed?.currency !== 'ILS' || !Number.isFinite(parsed.amount)) {
          continue;
        }
        const location = await el.getLocation().catch(() => ({ x: 0, y: 0 }));
        if (location.y < 40) {
          continue;
        }
        candidates.push({ amount: parsed.amount, y: location.y });
      } catch {
        continue;
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }
    candidates.sort((a, b) => a.y - b.y);
    return candidates[0].amount;
  }

  private async readBalance(): Promise<number | undefined> {
    const fromShekelScan = await this.ilsAmountFromShekelNodes();
    if (fromShekelScan !== undefined) {
      return fromShekelScan;
    }

    const el = (await this.waitForFirst(PEPPER_BALANCE_SELECTORS, UI_WAIT_MS)) as unknown as PepperUiElement;
    const text = await this.readAccessibleText(el);
    const parsed = parseCurrencyAmountSnippet(text);
    if (parsed?.currency === 'ILS' && Number.isFinite(parsed.amount)) {
      return parsed.amount;
    }
    const fromCompound = firstIlsAmountFromCompoundText(text);
    if (fromCompound !== undefined) {
      return fromCompound;
    }
    const numeric = parseFloat(text.replace(PEPPER_BALANCE_AMOUNT_STRIP_REGEX, '').trim());
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    throw new Error('Could not parse Pepper balance from UI');
  }

  private async foreignBalancesBroadScan(): Promise<CurrencyAmount[] | undefined> {
    const windowSize = await this.driver.getWindowSize().catch(() => ({ width: 1080, height: 2400 }));
    const yLimit = Math.min(Math.round(windowSize.height * 0.94), 3200);
    const elements = await this.queryElements(PEPPER_FOREIGN_CURRENCY_NODE_SELECTOR);
    const gathered: CurrencyAmount[] = [];

    for (const el of elements.slice(0, 80)) {
      try {
        const location = await el.getLocation().catch(() => ({ x: 0, y: 99_999 }));
        if (location.y > yLimit) {
          continue;
        }
        const text = await this.readAccessibleText(el);
        if (!text || text.length > 520 || !PEPPER_FOREIGN_CURRENCY_HINT_REGEX.test(text)) {
          continue;
        }
        gathered.push(...extractForeignCurrencyAmountsFromText(text));
      } catch {
        continue;
      }
    }

    const deduped = dedupeCurrencyAmounts(gathered);
    return deduped.length > 0 ? deduped : undefined;
  }

  private async readAccountTotals(): Promise<PepperAccountTotals> {
    const savings = await this.ilsAmountAfterLabel('חסכונות', 1);
    const investments =
      (await this.ilsAmountAfterLabel('תיק השקעות', 1)) ?? (await this.ilsAmountAfterLabel('תיק ההשקעות', 1));
    const foreignCurrency = await this.foreignBalancesBroadScan();

    const totals: PepperAccountTotals = {};
    if (savings !== undefined) {
      totals.savings = savings;
    }
    if (investments !== undefined) {
      totals.investments = investments;
    }
    if (foreignCurrency && foreignCurrency.length > 0) {
      totals.foreignCurrency = foreignCurrency;
    }
    return Object.keys(totals).length > 0 ? totals : {};
  }

  private async readAccountNumberFromProfileClipboard(): Promise<string | undefined> {
    this.tapByCoordinates(
      PEPPER_PROFILE_COORDINATES.openProfileFromHome.x,
      PEPPER_PROFILE_COORDINATES.openProfileFromHome.y,
    );
    await this.isAnyDisplayed(PEPPER_PROFILE_SCREEN_SELECTORS, UI_WAIT_MS);
    this.tapByCoordinates(
      PEPPER_PROFILE_COORDINATES.copyAccountNumberControl.x,
      PEPPER_PROFILE_COORDINATES.copyAccountNumberControl.y,
    );

    const clipboard = await this.readAndroidClipboardPlaintext();

    if (!clipboard) {
      return undefined;
    }

    const stripped = stripBidirectionalAndTrim(clipboard);
    const candidates = [normalizePepperAccountNumber(stripped)];
    const accountLine = stripped.match(PEPPER_ACCOUNT_LINE_REGEX);
    if (accountLine) {
      candidates.push(normalizePepperAccountNumber(accountLine[0]));
    }
    const dashed = stripped.match(PEPPER_DASHED_ACCOUNT_TOKEN_REGEX);
    if (dashed) {
      candidates.push(normalizePepperAccountNumber(dashed[0]));
    }
    const digitsOnly = stripped.replace(/\D/g, '');
    if (digitsOnly.length >= 6 && digitsOnly.length <= 14) {
      candidates.push(digitsOnly);
    }
    return candidates.find(isLikelyPepperAccountToken);
  }

  private async readAccountTotalsSafely(): Promise<PepperAccountTotals> {
    try {
      return await this.readAccountTotals();
    } catch (error) {
      debug('readAccountTotals failed: %s', errorMessage(error));
      return {};
    }
  }

  private async readBalanceSafely(): Promise<number | undefined> {
    try {
      return await this.readBalance();
    } catch (error) {
      debug('readBalance failed: %s', errorMessage(error));
      return undefined;
    }
  }

  private async readAccountNumberSafely(): Promise<string> {
    try {
      const accountNumber = await this.readAccountNumberFromProfileClipboard();
      if (accountNumber && accountNumber.length > 0) {
        return accountNumber;
      }
    } catch (error) {
      debug('readAccountNumber failed: %s', errorMessage(error));
    }
    return 'unknown';
  }
}

export type { PepperCredentials } from './pepper-types';
