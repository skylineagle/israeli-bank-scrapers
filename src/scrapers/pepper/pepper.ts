import { getDebug } from '../../helpers/debug';
import { sleep, TimeoutError } from '../../helpers/waiting';
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
  phoneDigitsMatch,
  toIsraeliDialerDigits,
  toIsraeliE164Phone,
} from './pepper-parsing';
import {
  LOGIN_UI_WAIT_MS,
  PEPPER_ACCOUNT_LINE_REGEX,
  PEPPER_BALANCE_AMOUNT_STRIP_REGEX,
  PEPPER_BALANCE_SELECTORS,
  PEPPER_CONTINUE_SELECTORS,
  PEPPER_DASHED_ACCOUNT_TOKEN_REGEX,
  PEPPER_FOREIGN_CURRENCY_HINT_REGEX,
  PEPPER_FOREIGN_CURRENCY_NODE_SELECTOR,
  PEPPER_HOME_DASHBOARD_READY_SELECTORS,
  PEPPER_HOME_TAB_SELECTORS,
  PEPPER_LOGGED_IN_SELECTORS,
  PEPPER_LOGIN_SUBMIT_TEXT_SELECTORS,
  PEPPER_NOTIFICATION_POPUP_DISMISS_SELECTORS,
  PEPPER_NOTIFICATION_POPUP_SELECTORS,
  PEPPER_OTP_FOCUS_SELECTORS,
  PEPPER_OTP_INPUT_SELECTORS,
  PEPPER_OTP_SCREEN_MARKERS,
  PEPPER_PACKAGE_NAME,
  PEPPER_PASSWORD_SELECTORS,
  PEPPER_PHONE_SELECTORS,
  PEPPER_PHONE_SELECTORS_STRICT,
  PEPPER_POST_CREDENTIALS_SUBMIT_SELECTORS,
  PEPPER_PROFILE_COORDINATES,
  PEPPER_PROFILE_SCREEN_SELECTORS,
  PEPPER_SHEKEL_NODE_SELECTOR,
  PEPPER_SHEKEL_PREDICATE,
  PEPPER_TERMS_AGREE_SELECTORS,
  PEPPER_TERMS_CHECKBOX_SELECTORS,
  PEPPER_TERMS_SCREEN_SELECTORS,
  PEPPER_VERIFY_SELECTORS,
  PEPPER_WELCOME_CONTINUE_SELECTORS,
  uiSelector,
} from './pepper-selectors';
import { type PepperAccountTotals, type PepperCredentials } from './pepper-types';

const debug = getDebug('pepper');

/** Minimal structural view of a WebdriverIO element with only the members this scraper uses. */
type PepperUiElement = {
  getText: () => Promise<string>;
  getAttribute: (name: string) => Promise<string | null>;
  isDisplayed: () => Promise<boolean>;
  isExisting: () => Promise<boolean>;
  getLocation: () => Promise<{ x: number; y: number }>;
  getSize: () => Promise<{ width: number; height: number }>;
  waitForDisplayed: (options: { timeout: number }) => Promise<unknown>;
  parentElement: () => PepperUiElement;
  $$: (selector: string) => { getElements: () => Promise<PepperUiElement[]> };
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export default class PepperScraper extends BaseAndroidAppScraper<PepperCredentials> {
  get appPackage(): string {
    return PEPPER_PACKAGE_NAME;
  }

  protected override async prepareEmulatorSnapshotState(): Promise<void> {
    // Close the app before saving the snapshot so the next run always starts Pepper fresh via
    // Appium, with no stale navigation state to restore (e.g. a left-open profile screen).
    this.spawnAdb(['am', 'force-stop', PEPPER_PACKAGE_NAME]);
    // Brief settle so the force-stop completes before the RAM snapshot is captured.
    await sleep(600);
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

    await this.ensureSessionUiReady();

    const earlyResult = await this.handleAlreadyAuthenticatedScreens();
    if (earlyResult) {
      return earlyResult;
    }

    debug('Entering phone number');
    await this.enterPhoneStep(credentials);
    await this.dismissKeyboard();
    this.stepLog('pepper.login.after_phone', {});

    const passwordAlreadyVisible = await this.isAnyVisible(PEPPER_PASSWORD_SELECTORS, 4_500);
    if (!passwordAlreadyVisible) {
      await this.tapContinueIfPresent(5_500);
    }

    debug('Waiting for password field');
    await this.waitForPasswordField();
    await this.typeIntoAny(PEPPER_PASSWORD_SELECTORS, credentials.password.trim(), LOGIN_UI_WAIT_MS);
    await this.dismissKeyboard();

    // Autofill overlays (e.g. Google Password Manager) can cover the next screen after typing.
    await this.ensureForeground();
    await this.submitCredentialsIfNeeded();

    debug('Waiting for home or optional SMS/code step');
    const afterPassword = await this.pollLoggedInOrOtp(48_000);
    if (afterPassword === 'logged_in') {
      debug('Logged in without SMS/code verification step');
      return { success: true };
    }

    return this.completeOtpStep(credentials);
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    debug('Reading account info');
    await this.ensureHomeDashboard();

    const accountTotals = await this.readAccountTotalsSafely();
    const balance = await this.readBalanceSafely();
    const accountNumber = await this.readAccountNumberSafely();

    const account: TransactionsAccount = {
      ...accountTotals,
      accountNumber,
      balance,
      txns: [],
    };

    return { success: true, accounts: [account] };
  }

  // ---------------------------------------------------------------------------
  // Element helpers
  // ---------------------------------------------------------------------------

  private element(selector: string): PepperUiElement {
    return this.driver.$(selector) as unknown as PepperUiElement;
  }

  private async queryElements(selector: string): Promise<PepperUiElement[]> {
    return (await this.driver
      .$$(selector)
      .getElements()
      .catch(() => [])) as unknown as PepperUiElement[];
  }

  // ---------------------------------------------------------------------------
  // Screen detection
  // ---------------------------------------------------------------------------

  private async isLoginScreen(): Promise<boolean> {
    return (
      (await this.isAnyVisible(PEPPER_PHONE_SELECTORS_STRICT, 1_200)) ||
      (await this.isAnyVisible(PEPPER_WELCOME_CONTINUE_SELECTORS, 900)) ||
      (await this.isAnyVisible(PEPPER_PASSWORD_SELECTORS, 900))
    );
  }

  private async isAuthenticatedAppScreen(): Promise<boolean> {
    if (await this.isLoginScreen()) {
      return false;
    }
    return (
      (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 1_500)) ||
      (await this.isAnyVisible(PEPPER_LOGGED_IN_SELECTORS, 1_500)) ||
      (await this.isAnyVisible(PEPPER_PROFILE_SCREEN_SELECTORS, 1_500)) ||
      (await this.isAnyVisible(PEPPER_HOME_TAB_SELECTORS, 1_200))
    );
  }

  private async isOtpPhaseVisible(): Promise<boolean> {
    return (
      (await this.isAnyVisible(PEPPER_OTP_INPUT_SELECTORS, 550)) ||
      (await this.isAnyVisible(PEPPER_OTP_SCREEN_MARKERS, 550))
    );
  }

  private async isLoginChromeVisible(): Promise<boolean> {
    return (
      (await this.isAnyVisible(PEPPER_PASSWORD_SELECTORS, 450)) ||
      (await this.isAnyVisible(PEPPER_LOGIN_SUBMIT_TEXT_SELECTORS, 450))
    );
  }

  // ---------------------------------------------------------------------------
  // Session restoration
  // ---------------------------------------------------------------------------

  /**
   * After a session-snapshot load the app may reopen on the profile or another sub-screen.
   * Return to the home dashboard before login checks or before saving a new snapshot.
   */
  private async ensureSessionUiReady(): Promise<void> {
    await this.dismissNotificationPopupIfPresent();

    if (await this.isLoginScreen()) {
      // After a force-stop relaunch Pepper briefly shows the login screen before reading its
      // auth token and navigating home. Wait to distinguish a transient state from a real logout.
      const navigatedHome = await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 8_000);
      if (!navigatedHome) {
        return;
      }
    }

    if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 2_000)) {
      return;
    }

    // The profile back button has no accessible label, so tap it by coordinate before entering
    // the slower recovery loop (saves a long sequence of fruitless back/home-tab attempts).
    if (await this.isAnyVisible(PEPPER_PROFILE_SCREEN_SELECTORS, 1_500)) {
      this.tapProfileBackButton();
      if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 3_000)) {
        return;
      }
    }

    this.stepLog('pepper.session.restore_ui', {});
    debug('Restoring Pepper UI to home (session snapshot may have opened off-dashboard)');
    await this.recoverHomeDashboard();
  }

  private async recoverHomeDashboard(): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 1_400)) {
        return;
      }
      if (await this.isLoginScreen()) {
        return;
      }
      if (await this.isAnyVisible(PEPPER_PROFILE_SCREEN_SELECTORS, 800)) {
        this.tapProfileBackButton();
        continue;
      }
      if (await this.isAnyVisible(PEPPER_HOME_TAB_SELECTORS, 1_000)) {
        try {
          await this.tapAny(PEPPER_HOME_TAB_SELECTORS, 6_000);
          if (await this.isAnyVisible(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 6_000)) {
            return;
          }
          // Home tab was tapped — pressing Back would undo it, so re-check on the next pass.
          continue;
        } catch {
          /* fall through to Back navigation */
        }
      }
      await this.pressAndroidBack();
    }

    try {
      await this.ensureHomeDashboard();
    } catch (error) {
      debug('ensureHomeDashboard after session UI restore failed: %s', errorMessage(error));
    }
  }

  private async ensureHomeDashboard(): Promise<void> {
    debug('Ensuring Pepper בית dashboard before reads');
    await this.dismissNotificationPopupIfPresent();
    try {
      await this.tapAny(PEPPER_HOME_TAB_SELECTORS, 22_000);
    } catch {
      debug('Home tab tap skipped or failed; continuing to wait for dashboard');
    }
    await this.waitForAnyDisplayed(PEPPER_HOME_DASHBOARD_READY_SELECTORS, 5_000);
  }

  // ---------------------------------------------------------------------------
  // Login steps
  // ---------------------------------------------------------------------------

  private async handleAlreadyAuthenticatedScreens(): Promise<ScraperLoginResult | undefined> {
    if (await this.isLoginScreen()) {
      this.stepLog('pepper.login.after_welcome', {});
      return undefined;
    }

    debug('Login form not visible — checking if already logged in');
    if (await this.isAuthenticatedAppScreen()) {
      await this.ensureSessionUiReady();
      debug('Existing session found, skipping login');
      return { success: true };
    }

    // The terms page can be showing if the app was interrupted after OTP but before acceptance.
    if (await this.isAnyVisible(PEPPER_TERMS_SCREEN_SELECTORS, 3_000)) {
      this.stepLog('pepper.login.terms_at_start', {});
      debug('Terms page showing at session start; accepting and waiting for home');
      await this.acceptTermsIfPresent(12_000);
      await this.waitForAnyDisplayed(PEPPER_LOGGED_IN_SELECTORS, 30_000);
      return { success: true };
    }

    await this.dismissWelcomeIfPresent();
    this.stepLog('pepper.login.after_welcome', {});
    return undefined;
  }

  private async dismissWelcomeIfPresent(): Promise<void> {
    if (!(await this.isAnyVisible(PEPPER_WELCOME_CONTINUE_SELECTORS, 8_000))) {
      return;
    }
    debug('Dismissing welcome / marketing screen');
    await this.tapAny(PEPPER_WELCOME_CONTINUE_SELECTORS, 22_000);
  }

  private async enterPhoneStep(credentials: PepperCredentials): Promise<void> {
    const dialDigits = toIsraeliDialerDigits(toIsraeliE164Phone(credentials.phoneNumber));

    if (await this.isAnyVisible(PEPPER_PASSWORD_SELECTORS, 4_500)) {
      // Skip phone entry only on the password-only step of a two-step wizard; on a combined
      // phone+password form both fields are visible and the phone must still be entered.
      const phoneAlsoVisible = await this.isAnyVisible(PEPPER_PHONE_SELECTORS_STRICT, 1_500);
      if (!phoneAlsoVisible) {
        this.stepLog('pepper.login.skip_phone_password_visible', {});
        return;
      }
      this.stepLog('pepper.login.combined_form_detected', {});
    }

    if (await this.isAnyVisible(PEPPER_PHONE_SELECTORS_STRICT, 11_000)) {
      const existing = await this.readStrictPhoneFieldValue();
      if (phoneDigitsMatch(existing, dialDigits)) {
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

  private async readStrictPhoneFieldValue(): Promise<string> {
    for (const selector of PEPPER_PHONE_SELECTORS_STRICT) {
      try {
        const element = this.element(selector);
        await element.waitForDisplayed({ timeout: 1_600 });
        const text = await element.getText();
        return typeof text === 'string' ? text : '';
      } catch {
        continue;
      }
    }
    return '';
  }

  private async enterPhoneDigitsViaKeypad(digits: string): Promise<void> {
    try {
      debug('Entering phone via WebDriver keycodes (%d digits)', digits.length);
      await this.pressDigitsViaDriverKeyCode(digits);
      return;
    } catch (error) {
      debug('WebDriver keycode entry unavailable, using on-screen keypad: %s', errorMessage(error));
    }

    for (const character of digits) {
      await this.tapAny(
        [
          `//*[@text="${character}" and (@clickable="true" or @focusable="true")]`,
          uiSelector(`text("${character}").clickable(true)`),
        ],
        14_000,
      );
    }
  }

  private async tapContinueIfPresent(visibleBudgetMs: number): Promise<void> {
    if (!(await this.isAnyVisible(PEPPER_CONTINUE_SELECTORS, visibleBudgetMs))) {
      return;
    }
    this.stepLog('pepper.login.tap_continue', {});
    await this.tapAny(PEPPER_CONTINUE_SELECTORS, 14_000);
    await this.ensureForeground();
  }

  private async waitForPasswordField(): Promise<void> {
    await this.ensureForeground();
    try {
      await this.waitForAnyDisplayed(PEPPER_PASSWORD_SELECTORS, 35_000);
      return;
    } catch (error) {
      this.stepLog('pepper.password.wait_failed_once', { message: errorMessage(error).slice(0, 240) });
      await this.pressAndroidBack();
      await this.ensureForeground();
      await this.waitForAnyDisplayed(PEPPER_PASSWORD_SELECTORS, 28_000);
    }
  }

  private async submitCredentialsIfNeeded(): Promise<void> {
    // Check OTP first (the server often triggers it the moment valid credentials are typed),
    // then the home screen, then the sign-in button — most to least likely.
    if (await this.isOtpPhaseVisible()) {
      debug('OTP screen visible immediately after password entry');
      return;
    }
    if (await this.isAnyVisible(PEPPER_LOGGED_IN_SELECTORS, 3_000)) {
      debug('Already on Pepper home; skipping sign-in tap');
      return;
    }

    try {
      await this.tapAny(PEPPER_POST_CREDENTIALS_SUBMIT_SELECTORS, 14_000);
    } catch (error) {
      // An overlay may have appeared during the tap — dismiss it and re-check the app state.
      await this.ensureForeground();
      if (await this.isOtpPhaseVisible()) {
        debug('OTP appeared (was obscured by overlay)');
        return;
      }
      if (await this.isAnyVisible(PEPPER_LOGGED_IN_SELECTORS, 3_000)) {
        debug('Home visible after sign-in button timeout — continuing');
        return;
      }
      throw error;
    }
  }

  private async pollLoggedInOrOtp(totalMs: number): Promise<'logged_in' | 'otp'> {
    const deadline = Date.now() + totalMs;
    let blankCycles = 0;
    while (Date.now() < deadline) {
      // Check OTP before the long logged-in selector list: it appears within milliseconds of the
      // server validating credentials, and checking it first saves time per poll iteration.
      if (await this.isOtpPhaseVisible()) {
        return 'otp';
      }
      if (await this.isAnyVisible(PEPPER_LOGGED_IN_SELECTORS, 750)) {
        return 'logged_in';
      }
      if (await this.isAnyVisible(PEPPER_TERMS_SCREEN_SELECTORS, 450)) {
        this.stepLog('pepper.login.terms_after_password', {});
        await this.acceptTermsIfPresent(12_000);
        blankCycles = 0;
        continue;
      }
      if (await this.isLoginChromeVisible()) {
        await this.tapPostCredentialsSubmitIfPresent();
        blankCycles = 0;
        continue;
      }
      blankCycles += 1;
      if (blankCycles % 3 === 0) {
        // After several blank cycles, dismiss any system overlay covering the screen.
        await this.ensureForeground();
      }
      await sleep(420);
    }
    throw new TimeoutError(`Timed out after ${totalMs}ms waiting for Pepper home screen or SMS/code verification UI`);
  }

  private async tapPostCredentialsSubmitIfPresent(): Promise<void> {
    if (!(await this.isAnyVisible(PEPPER_POST_CREDENTIALS_SUBMIT_SELECTORS, 2_800))) {
      return;
    }
    await this.tapAny(PEPPER_POST_CREDENTIALS_SUBMIT_SELECTORS, 14_000);
  }

  private async completeOtpStep(credentials: PepperCredentials): Promise<ScraperLoginResult> {
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

    await this.enterOtpCode(otpCode);
    await this.tapVerifyIfPresent();

    // One-time terms-of-use acceptance screen that can appear after first OTP verification.
    await this.acceptTermsIfPresent(8_000);

    debug('Waiting for home screen after OTP');
    await this.waitForAnyDisplayed(PEPPER_LOGGED_IN_SELECTORS, 45_000);
    return { success: true };
  }

  /**
   * Enter the OTP into Pepper's custom React Native digit-box widget.
   * The keyboard is usually already open with the first box focused; if it is closed (e.g. dismissed
   * by UiAutomator2 accessibility queries) we tap the input to reopen it, then send digit keyevents.
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

    if (await this.isAnyVisible(PEPPER_PHONE_SELECTORS_STRICT, 600)) {
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
  }

  private async tapVerifyIfPresent(): Promise<void> {
    if (!(await this.isAnyVisible(PEPPER_VERIFY_SELECTORS, 2_800))) {
      debug('No OTP verify button found; assuming submit happens automatically');
      return;
    }
    await this.tapAny(PEPPER_VERIFY_SELECTORS, 14_000);
  }

  private async ensureForeground(maxPresses = 4): Promise<void> {
    for (let attempt = 0; attempt < maxPresses; attempt += 1) {
      const foregroundPackage = await this.readForegroundPackage();
      this.stepLog('pepper.login.foreground', { package: foregroundPackage || '(unknown)', attempt });
      if (!foregroundPackage || foregroundPackage === PEPPER_PACKAGE_NAME) {
        return;
      }
      await this.pressAndroidBack();
    }
  }

  private async dismissNotificationPopupIfPresent(): Promise<void> {
    if (!(await this.isAnyVisible(PEPPER_NOTIFICATION_POPUP_SELECTORS, 2_500))) {
      return;
    }
    debug('Notification opt-in popup detected; dismissing');
    await this.tapAny(PEPPER_NOTIFICATION_POPUP_DISMISS_SELECTORS, 8_000);
  }

  private async acceptTermsIfPresent(timeoutMs: number): Promise<void> {
    if (!(await this.isAnyVisible(PEPPER_TERMS_SCREEN_SELECTORS, timeoutMs))) {
      return;
    }
    debug('Terms of use screen detected; accepting');
    this.stepLog('pepper.login.terms_screen', {});

    if (await this.isAnyVisible(PEPPER_TERMS_CHECKBOX_SELECTORS, 4_000)) {
      await this.tapAny(PEPPER_TERMS_CHECKBOX_SELECTORS, 8_000);
    }
    await this.tapAny(PEPPER_TERMS_AGREE_SELECTORS, 10_000);
    debug('Terms accepted');
  }

  // ---------------------------------------------------------------------------
  // Data reads
  // ---------------------------------------------------------------------------

  private async ilsAmountAfterLabel(label: string, nth: number): Promise<number | undefined> {
    const labelPredicate = `contains(@text,"${label}") or contains(@content-desc,"${label}")`;
    const selector = `//*[${labelPredicate}]/following::*[${PEPPER_SHEKEL_PREDICATE}][${nth}]`;
    const element = this.element(selector);
    if (!(await element.isExisting().catch(() => false))) {
      return undefined;
    }
    const parsed = parseCurrencyAmountSnippet(await this.readAccessibleText(element));
    return parsed?.currency === 'ILS' && Number.isFinite(parsed.amount) ? parsed.amount : undefined;
  }

  private async ilsAmountFromShekelNodes(): Promise<number | undefined> {
    const elements = await this.queryElements(PEPPER_SHEKEL_NODE_SELECTOR);
    const candidates: { amount: number; y: number }[] = [];
    for (const element of elements) {
      try {
        if (!(await element.isDisplayed())) {
          continue;
        }
        const parsed = parseCurrencyAmountSnippet(await this.readAccessibleText(element));
        if (parsed?.currency !== 'ILS' || !Number.isFinite(parsed.amount)) {
          continue;
        }
        const location = await element.getLocation().catch(() => ({ x: 0, y: 0 }));
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
    candidates.sort((first, second) => first.y - second.y);
    return candidates[0].amount;
  }

  private async readBalance(): Promise<number | undefined> {
    const fromShekelScan = await this.ilsAmountFromShekelNodes();
    if (fromShekelScan !== undefined) {
      return fromShekelScan;
    }
    return this.readBalanceFromSelectorsFallback();
  }

  private async readBalanceFromSelectorsFallback(): Promise<number> {
    const element = (await this.waitForAnyDisplayed(PEPPER_BALANCE_SELECTORS, 18_000)) as unknown as PepperUiElement;
    const text = await this.readAccessibleText(element);

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

  /**
   * Read foreign-currency balances by querying only nodes that carry a currency marker
   * (PEPPER_FOREIGN_CURRENCY_NODE_SELECTOR) instead of scanning every node on screen — the latter
   * cost ~25s per run. Off-screen rows (below the visible area) are skipped via the y limit.
   */
  private async foreignBalancesBroadScan(): Promise<CurrencyAmount[] | undefined> {
    const windowSize = await this.driver.getWindowSize().catch(() => ({ width: 1080, height: 2400 }));
    const yLimit = Math.min(Math.round(windowSize.height * 0.94), 3200);
    const elements = await this.queryElements(PEPPER_FOREIGN_CURRENCY_NODE_SELECTOR);
    const gathered: CurrencyAmount[] = [];

    for (const element of elements.slice(0, 80)) {
      try {
        const location = await element.getLocation().catch(() => ({ x: 0, y: 99_999 }));
        if (location.y > yLimit) {
          continue;
        }
        const text = await this.readAccessibleText(element);
        if (!text || text.length > 520 || !PEPPER_FOREIGN_CURRENCY_HINT_REGEX.test(text)) {
          continue;
        }
        gathered.push(...extractForeignCurrencyAmountsFromText(text));
      } catch {}
    }

    const deduped = dedupeCurrencyAmounts(gathered);
    return deduped.length > 0 ? deduped : undefined;
  }

  private async readAccountTotals(): Promise<PepperAccountTotals | undefined> {
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
    return Object.keys(totals).length > 0 ? totals : undefined;
  }

  // ---------------------------------------------------------------------------
  // Account number (profile clipboard)
  // ---------------------------------------------------------------------------

  private tapProfileBackButton(): void {
    this.stepLog('pepper.session.profile_back', {});
    this.tapByCoordinates(PEPPER_PROFILE_COORDINATES.backButton.x, PEPPER_PROFILE_COORDINATES.backButton.y);
  }

  private accountNumberCandidates(strippedClipboard: string): string[] {
    const candidates = [normalizePepperAccountNumber(strippedClipboard)];

    const accountLine = strippedClipboard.match(PEPPER_ACCOUNT_LINE_REGEX);
    if (accountLine) {
      candidates.push(normalizePepperAccountNumber(accountLine[0]));
    }
    const dashed = strippedClipboard.match(PEPPER_DASHED_ACCOUNT_TOKEN_REGEX);
    if (dashed) {
      candidates.push(normalizePepperAccountNumber(dashed[0]));
    }
    const digitsOnly = strippedClipboard.replace(/\D/g, '');
    if (digitsOnly.length >= 6 && digitsOnly.length <= 14) {
      candidates.push(digitsOnly);
    }
    return candidates;
  }

  private async readAccountNumberFromProfileClipboard(): Promise<string | undefined> {
    await this.ensureHomeDashboard();
    this.tapByCoordinates(
      PEPPER_PROFILE_COORDINATES.openProfileFromHome.x,
      PEPPER_PROFILE_COORDINATES.openProfileFromHome.y,
    );

    // Wait for the profile screen before tapping the (selector-less) copy control by coordinate.
    await this.isAnyVisible(PEPPER_PROFILE_SCREEN_SELECTORS, 4_000);
    this.tapByCoordinates(
      PEPPER_PROFILE_COORDINATES.copyAccountNumberControl.x,
      PEPPER_PROFILE_COORDINATES.copyAccountNumberControl.y,
    );

    const clipboard = await this.readAndroidClipboardPlaintext();
    // Navigation back from the profile page is unreliable; close the app so the next run starts
    // fresh from the snapshot (saved by prepareEmulatorSnapshotState with Pepper closed).
    this.spawnAdb(['am', 'force-stop', PEPPER_PACKAGE_NAME]);

    if (!clipboard) {
      return undefined;
    }
    return this.accountNumberCandidates(stripBidirectionalAndTrim(clipboard)).find(isLikelyPepperAccountToken);
  }

  // ---------------------------------------------------------------------------
  // fetchData helpers
  // ---------------------------------------------------------------------------

  private async readAccountTotalsSafely(): Promise<PepperAccountTotals | undefined> {
    try {
      return await this.readAccountTotals();
    } catch (error) {
      debug('readAccountTotals failed: %s', errorMessage(error));
      return undefined;
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
