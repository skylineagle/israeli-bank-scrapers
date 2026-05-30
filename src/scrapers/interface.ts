import { type BrowserContext, type Browser, type Page } from 'puppeteer';
import { type CompanyTypes, type ScraperProgressTypes } from '../definitions';
import { type TransactionsAccount } from '../transactions';
import { type ErrorResult, type ScraperErrorTypes } from './errors';

// TODO: Remove this type when the scraper 'factory' will return concrete scraper types
// Instead of a generic interface (which in turn uses this type)
export type ScraperCredentials =
  | { userCode: string; password: string }
  | { username: string; password: string }
  | { id: string; password: string }
  | { id: string; password: string; num: string }
  | { id: string; password: string; card6Digits: string }
  | { username: string; nationalID: string; password: string }
  | ({ email: string; password: string } & (
      | {
          otpCodeRetriever: () => Promise<string>;
          phoneNumber: string;
        }
      | {
          otpLongTermToken: string;
        }
    ))
  | { phoneNumber: string; password: string; otpCodeRetriever?: () => Promise<string> };

export type OptInFeatures =
  | 'isracard-amex:skipAdditionalTransactionInformation'
  | 'mizrahi:pendingIfNoIdentifier'
  | 'mizrahi:pendingIfHasGenericDescription'
  | 'mizrahi:pendingIfTodayTransaction';

export interface FutureDebit {
  amount: number;
  amountCurrency: string;
  chargeDate?: string;
  bankAccountNumber?: string;
}

interface ExternalBrowserOptions {
  /**
   * An externally created browser instance.
   * you can get a browser directly from puppeteer via `puppeteer.launch()`
   *
   * Note: The browser will be closed by the library after the scraper finishes unless `skipCloseBrowser` is set to true
   */
  browser: Browser;

  /**
   * If true, the browser will not be closed by the library after the scraper finishes
   */
  skipCloseBrowser?: boolean;
}

interface ExternalBrowserContextOptions {
  /**
   * An externally managed browser context. This is useful when you want to manage the browser
   */
  browserContext: BrowserContext;
}

interface DefaultBrowserOptions {
  /**
   * shows the browser while scraping, good for debugging (default false)
   */
  showBrowser?: boolean;

  /**
   * provide a patch to local chromium to be used by puppeteer. Relevant when using
   * `israeli-bank-scrapers-core` library
   */
  executablePath?: string;

  /**
   * additional arguments to pass to the browser instance. The list of flags can be found in
   *
   * https://developer.mozilla.org/en-US/docs/Mozilla/Command_Line_Options
   * https://peter.sh/experiments/chromium-command-line-switches/
   */
  args?: string[];

  /**
   * Maximum navigation time in milliseconds, pass 0 to disable timeout.
   * @default 30000
   */
  timeout?: number;

  /**
   * adjust the browser instance before it is being used
   *
   * @param browser
   */
  prepareBrowser?: (browser: Browser) => Promise<void>;
}

type ScraperBrowserOptions = ExternalBrowserOptions | ExternalBrowserContextOptions | DefaultBrowserOptions;

export interface AndroidScraperOptions {
  /**
   * Android Virtual Device name to launch if no emulator is currently running.
   * Only used by Android app scrapers (e.g. Pepper).
   * If omitted, the first available AVD is used. Run `emulator -list-avds` to see options.
   * The scraper starts the emulator headless (`-no-window`) by default. Set DEBUG_ANDROID_EMULATOR_GUI=1 to show the emulator window.
   */
  avdName?: string;

  /**
   * Port for the Appium server. Only used by Android app scrapers (e.g. Pepper).
   * @default 4723
   */
  appiumPort?: number;

  /**
   * When the scraper launched an Android emulator itself, shut it down after terminate() (adb emu kill).
   * No effect when an emulator was already running before ensureEmulatorRunning().
   * @default true
   */
  shutdownEmulatorOnTerminate?: boolean;

  /**
   * AVD snapshot name to load when the scraper starts the emulator.
   * When omitted, loads `sessionSnapshotName` if that snapshot exists on the AVD, otherwise `baselineSnapshotName`.
   * Set ANDROID_COLD_BOOT=1 to skip snapshots and force a full cold boot instead.
   */
  snapshotName?: string;

  /**
   * Clean AVD snapshot (Pepper installed, logged out). Used on first run and when forcing a reset.
   * @default scraper-baseline
   */
  baselineSnapshotName?: string;

  /**
   * Persisted logged-in emulator state. Created automatically after a successful scrape when
   * `persistEmulatorSession` is true (default). Subsequent runs load this snapshot to skip OTP.
   * @default scraper-session
   */
  sessionSnapshotName?: string;

  /**
   * After a successful scrape (login + fetchData), save the current emulator RAM state to
   * `sessionSnapshotName` before shutting down. The next cold start loads that snapshot instead
   * of `baselineSnapshotName`, so OTP is usually skipped. Set ANDROID_NO_SESSION_SNAPSHOT=1 to disable.
   * @default true
   */
  persistEmulatorSession?: boolean;

  /**
   * Always boot from `baselineSnapshotName` (ignore any saved session snapshot).
   * Set ANDROID_FORCE_BASELINE=1 for the same behavior via environment variable.
   */
  forceBaselineSnapshot?: boolean;
}

export type ScraperOptions = ScraperBrowserOptions & {
  /**
   * The company you want to scrape
   */
  companyId: CompanyTypes;

  /**
   * include more debug info about in the output
   */
  verbose?: boolean;

  /**
   * the date to fetch transactions from (can't be before the minimum allowed time difference for the scraper)
   */
  startDate: Date;

  /**
   * scrape transactions to be processed X months in the future
   */
  futureMonthsToScrape?: number;

  /**
   * if set to true, all installment transactions will be combine into the first one
   */
  combineInstallments?: boolean;

  /**
   * adjust the page instance before it is being used.
   *
   * @param page
   */
  preparePage?: (page: Page) => Promise<void>;

  /**
   * if set, store a screenshot if failed to scrape. Used for debug purposes
   */
  storeFailureScreenShotPath?: string;

  /**
   * if set, will set the timeout in milliseconds of puppeteer's `page.setDefaultTimeout`.
   */
  defaultTimeout?: number;

  /**
   * Options for manipulation of output data
   */
  outputData?: OutputDataOptions;

  /**
   * Perform additional operation for each transaction to get more information (Like category) about it.
   * Please note: It will take more time to finish the process.
   */
  additionalTransactionInformation?: boolean;

  /**
   * Include the raw transaction object as received from the scraper source for debugging purposes.
   * @default false
   */
  includeRawTransaction?: boolean;

  /**
   * Adjust the viewport size of the browser page.
   * If not set, the default viewport size of 1024x768 will be used.
   */
  viewportSize?: {
    width: number;
    height: number;
  };

  /**
   * The number of times to retry the navigation in case of a failure (default 0)
   */
  navigationRetryCount?: number;

  /**
   * Opt-in features for the scrapers, allowing safe rollout of new breaking changes.
   */
  optInFeatures?: Array<OptInFeatures>;
} & AndroidScraperOptions;

export interface OutputDataOptions {
  /**
   * if true, the result wouldn't be filtered out by date, and you will return unfiltered scrapped data.
   */
  enableTransactionsFilterByDate?: boolean;
}

export interface ScraperScrapingResult {
  success: boolean;
  accounts?: TransactionsAccount[];
  futureDebits?: FutureDebit[];
  errorType?: ScraperErrorTypes;
  errorMessage?: string; // only on success=false
}

export interface Scraper<TCredentials extends ScraperCredentials> {
  scrape(credentials: TCredentials): Promise<ScraperScrapingResult>;
  onProgress(func: (companyId: CompanyTypes, payload: { type: ScraperProgressTypes }) => void): void;
  triggerTwoFactorAuth(phoneNumber: string): Promise<ScraperTwoFactorAuthTriggerResult>;
  getLongTermTwoFactorToken(otpCode: string): Promise<ScraperGetLongTermTwoFactorTokenResult>;
}

export type ScraperTwoFactorAuthTriggerResult =
  | ErrorResult
  | {
      success: true;
    };

export type ScraperGetLongTermTwoFactorTokenResult =
  | ErrorResult
  | {
      success: true;
      longTermTwoFactorAuthToken: string;
    };

export interface ScraperLoginResult {
  success: boolean;
  errorType?: ScraperErrorTypes;
  errorMessage?: string; // only on success=false
  persistentOtpToken?: string;
}
