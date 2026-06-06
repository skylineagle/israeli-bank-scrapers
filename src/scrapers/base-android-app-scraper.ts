import { type ChildProcess, execSync, spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { type Browser, type ChainablePromiseElement, remote } from 'webdriverio';
import { adbDeviceTargetArgs, listAttachedEmulatorSerials, runAdbShell } from '../helpers/android-adb';
import {
  DEFAULT_ANDROID_BASELINE_SNAPSHOT,
  DEFAULT_ANDROID_SESSION_SNAPSHOT,
  emulatorSnapshotExists,
  resolveEmulatorSnapshotNames,
} from '../helpers/android-emulator-snapshots';
import { resolveAndroidLauncherAppActivity } from '../helpers/android-launcher';
import { registerAndroidProcessCleanup, unregisterAndroidProcessCleanup } from '../helpers/android-process-cleanup';
import { getDebug } from '../helpers/debug';
import { stripBidirectionalAndTrim } from '../helpers/text';
import { sleep } from '../helpers/waiting';
import { BaseScraper } from './base-scraper';
import type { AndroidScraperOptions, ScraperCredentials } from './interface';

const debug = getDebug('android-app-scraper');
const stepsDebug = getDebug('steps');

const APPIUM_HOST = 'localhost';
const DEFAULT_APPIUM_PORT = 4723;
const DEFAULT_WAIT_MS = 8_000;
const POLL_MS = 150;
const EMULATOR_BOOT_TIMEOUT_MS = 180_000;
const APPIUM_READY_TIMEOUT_MS = 30_000;
const EMULATOR_SHUTDOWN_TIMEOUT_MS = 20_000;
const SESSION_SNAPSHOT_SAVE_TIMEOUT_MS = 45_000;
const KEYCODE_BACK = 4;
const ANDROID_KEYCODE_DIGIT_ZERO = 7;
const ZERO_CHARACTER_CODE = '0'.charCodeAt(0);

type AccessibleElement = {
  getText: () => Promise<string>;
  getAttribute: (name: string) => Promise<string | null>;
};

type AppiumCapabilities = {
  platformName: 'Android';
  'appium:automationName': 'UiAutomator2';
  'appium:appPackage': string;
  'appium:appActivity': string;
  'appium:noReset': boolean;
  'appium:newCommandTimeout': number;
  'appium:waitAppLaunch': boolean;
  'appium:enforceXPath1': boolean;
  'appium:uiautomator2ServerInstallTimeout': number;
};

/**
 * Base class for driving a single bank app inside a dedicated emulator via Appium.
 *
 * Design: success-tailed. Each UI step uses one selector list and one wait budget.
 * Operations are not wrapped in session-recovery retries — a failure surfaces immediately
 * so the static flow can be fixed rather than masked.
 */
export abstract class BaseAndroidAppScraper<TCredentials extends ScraperCredentials> extends BaseScraper<TCredentials> {
  protected driver!: Browser;

  private appiumProcess?: ChildProcess;
  private ownedAppium = false;
  private ownedEmulator = false;
  private emulatorProcess?: ChildProcess;
  private cleanupRegistrationId = randomUUID();
  private terminateFinished = false;
  private startedEmulatorSerial?: string;
  private startedAvdName?: string;
  private bootedFromSessionSnapshot = false;
  private launcherActivity = '.MainActivity';

  protected abstract get appPackage(): string;

  protected launcherActivityExplicit(): string | undefined {
    return undefined;
  }

  private get androidOptions(): AndroidScraperOptions {
    return this.options;
  }

  private get resolvedAppiumPort(): number {
    return this.androidOptions.appiumPort ?? DEFAULT_APPIUM_PORT;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override async initialize(): Promise<void> {
    await super.initialize();
    await this.ensureEmulatorRunning();
    await this.ensureAppiumRunning();

    this.launcherActivity =
      this.launcherActivityExplicit() ?? (await resolveAndroidLauncherAppActivity(this.appPackage));
    debug('Using appPackage=%s appActivity=%s', this.appPackage, this.launcherActivity);

    const capabilities: AppiumCapabilities = {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': this.appPackage,
      'appium:appActivity': this.launcherActivity,
      'appium:noReset': true,
      'appium:newCommandTimeout': 90,
      'appium:waitAppLaunch': true,
      'appium:enforceXPath1': true,
      'appium:uiautomator2ServerInstallTimeout': 120_000,
    };

    if (process.env.ANDROID_SKIP_UIAUTOMATOR2_PRE_RESET !== '1') {
      this.resetStaleUiAutomator2Servers();
    }

    this.driver = await remote({
      hostname: APPIUM_HOST,
      port: this.resolvedAppiumPort,
      capabilities,
      logLevel: this.options.verbose ? 'info' : 'silent',
    });

    await this.activateApp();
    this.stepLog('android.session.ready', {
      appPackage: this.appPackage,
      appActivity: this.launcherActivity,
    });
  }

  protected override async terminate(success: boolean): Promise<void> {
    if (this.terminateFinished) {
      return;
    }
    this.terminateFinished = true;
    unregisterAndroidProcessCleanup(this.cleanupRegistrationId);

    const persistSession = this.shouldPersistEmulatorSession(success);
    if (persistSession) {
      try {
        await this.prepareEmulatorSnapshotState();
      } catch (e) {
        debug('prepareEmulatorSnapshotState failed: %s', e instanceof Error ? e.message : String(e));
      }
    }

    if (this.driver) {
      await this.driver.deleteSession().catch(() => undefined);
    }
    this.stopOwnedAppium();
    if (persistSession) {
      await this.saveEmulatorSessionSnapshot();
    }
    if (this.shouldShutdownOwnedEmulator()) {
      this.shutdownOwnedEmulator();
    }
    this.emulatorProcess = undefined;
    await super.terminate(success);
  }

  /** Override to navigate to a stable screen before saving the session snapshot. */
  protected async prepareEmulatorSnapshotState(): Promise<void> {}

  protected stepLog(event: string, detail?: Record<string, unknown>): void {
    const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
    const line = `${event}${suffix}`;
    stepsDebug(line);
    if (this.options.verbose) {
      process.stderr.write(`[israeli-bank-scrapers/steps][${this.options.companyId}] ${line}\n`);
    }
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  protected async waitFor(selector: string, timeoutMs = DEFAULT_WAIT_MS): Promise<ChainablePromiseElement> {
    const el = this.driver.$(selector);
    await el.waitForDisplayed({ timeout: timeoutMs });
    return el;
  }

  /** Poll `isDisplayed()` across selectors until one matches or the budget expires. */
  protected async waitForFirst(
    selectors: readonly string[],
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<ChainablePromiseElement> {
    this.stepLog('waitForFirst.start', {
      selectorCount: selectors.length,
      timeoutMs,
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let index = 0; index < selectors.length; index += 1) {
        const el = this.driver.$(selectors[index]);
        if (await el.isDisplayed().catch(() => false)) {
          this.stepLog('waitForFirst.ok', { selectorIndex: index });
          return el;
        }
      }
      await sleep(POLL_MS);
    }
    throw new Error(`None of ${selectors.length} selectors became visible within ${timeoutMs}ms`);
  }

  protected async tap(selector: string, timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const el = await this.waitFor(selector, timeoutMs);
    await el.click();
  }

  protected async tapFirst(selectors: readonly string[], timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    this.stepLog('tapFirst.start', {
      selectorCount: selectors.length,
      timeoutMs,
    });
    const el = await this.waitForFirst(selectors, timeoutMs);
    await el.click();
    this.stepLog('tapFirst.done', { selectorCount: selectors.length });
  }

  protected async typeInto(selector: string, value: string, timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const el = await this.waitFor(selector, timeoutMs);
    await el.click();
    await el.clearValue().catch(() => undefined);
    await el.setValue(value);
  }

  protected async typeIntoFirst(
    selectors: readonly string[],
    value: string,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<void> {
    this.stepLog('typeIntoFirst.start', {
      selectorCount: selectors.length,
      valueLength: value.length,
      timeoutMs,
    });
    const el = await this.waitForFirst(selectors, timeoutMs);
    await el.click();
    await el.clearValue().catch(() => undefined);
    await el.setValue(value);
    this.stepLog('typeIntoFirst.done', {
      selectorCount: selectors.length,
      valueLength: value.length,
    });
  }

  /** Quick visibility check; optional short poll when timeoutMs > 0. */
  protected async isDisplayed(selector: string): Promise<boolean> {
    return this.driver
      .$(selector)
      .isDisplayed()
      .catch(() => false);
  }

  protected async isAnyDisplayed(selectors: readonly string[], timeoutMs = 0): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      for (const selector of selectors) {
        if (await this.isDisplayed(selector)) {
          return true;
        }
      }
      if (timeoutMs <= 0) {
        return false;
      }
      await sleep(POLL_MS);
    } while (Date.now() < deadline);

    return false;
  }

  protected async waitForCondition(
    predicate: () => Promise<boolean>,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    const intervalMs = options.intervalMs ?? POLL_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return true;
      }
      await sleep(intervalMs);
    }
    return false;
  }

  protected async readAccessibleText(element: AccessibleElement): Promise<string> {
    const chunks: string[] = [];
    const addChunk = (value: string): void => {
      const cleaned = stripBidirectionalAndTrim(value);
      if (cleaned.length > 0 && cleaned.toLowerCase() !== 'null' && !chunks.includes(cleaned)) {
        chunks.push(cleaned);
      }
    };

    try {
      addChunk(await element.getText());
    } catch {
      /* element may not expose getText */
    }
    for (const attribute of ['content-desc', 'contentDescription', 'name', 'text']) {
      try {
        const value = await element.getAttribute(attribute);
        if (value != null && String(value).trim() !== '' && String(value).toLowerCase() !== 'null') {
          addChunk(String(value));
        }
      } catch {
        /* attribute not present */
      }
    }
    return stripBidirectionalAndTrim(chunks.join(' '));
  }

  protected tapByCoordinates(x: number, y: number): void {
    this.spawnAdb(['input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  }

  protected spawnAdb(shellArgs: readonly string[]): string {
    return runAdbShell(shellArgs);
  }

  protected async pressDigitsViaAdbKeyevent(digits: string, perKeyDelayMs = 60): Promise<void> {
    for (const character of digits) {
      this.spawnAdb(['input', 'keyevent', String(this.digitToKeycode(character))]);
      if (perKeyDelayMs > 0) {
        await sleep(perKeyDelayMs);
      }
    }
  }

  protected isAndroidKeyboardShown(): boolean {
    return this.spawnAdb(['dumpsys', 'input_method']).includes('mInputShown=true');
  }

  protected async pressAndroidBack(): Promise<void> {
    const driverLike = this.driver as unknown as {
      pressKeyCode?: (code: number) => Promise<void>;
    };
    if (typeof driverLike.pressKeyCode === 'function') {
      await driverLike.pressKeyCode(KEYCODE_BACK);
    } else {
      await this.driver.execute('mobile: pressKey', { keycode: KEYCODE_BACK });
    }
    await sleep(200);
  }

  protected async readCurrentPackage(): Promise<string> {
    const driverLike = this.driver as unknown as {
      getCurrentPackage?: () => Promise<string>;
    };
    if (typeof driverLike.getCurrentPackage !== 'function') {
      return '';
    }
    try {
      return (await driverLike.getCurrentPackage.call(this.driver)) ?? '';
    } catch {
      return '';
    }
  }

  protected async readAndroidClipboardPlaintext(): Promise<string> {
    const clipboard = await this.driver.getClipboard();
    if (!clipboard || clipboard.length === 0) {
      return '';
    }
    return Buffer.from(clipboard, 'base64').toString('utf8');
  }

  // ---------------------------------------------------------------------------
  // Emulator / Appium / foreground
  // ---------------------------------------------------------------------------

  /** Bring the target app back to the foreground (e.g. after waiting for user OTP input). */
  protected async ensureAppInForeground(): Promise<void> {
    await this.activateApp();
  }

  private async activateApp(): Promise<void> {
    const current = await this.readCurrentPackage();
    if (current === this.appPackage) {
      debug('Foreground ok: %s', current);
      return;
    }

    debug('Activating %s (current=%s)', this.appPackage, current || '(unknown)');
    await this.driver.execute('mobile: activateApp', {
      appId: this.appPackage,
    });

    const focused = await this.waitForCondition(async () => (await this.readCurrentPackage()) === this.appPackage, {
      timeoutMs: 8_000,
      intervalMs: 300,
    });
    if (!focused) {
      throw new Error(`Could not bring ${this.appPackage} to foreground after activateApp`);
    }
    debug('Foreground ok: %s', this.appPackage);
  }

  private resetStaleUiAutomator2Servers(): void {
    const adb = adbDeviceTargetArgs();
    const pkgs = ['io.appium.uiautomator2.server', 'io.appium.uiautomator2.server.test'];
    for (const pkg of pkgs) {
      const check = spawnSync('adb', [...adb, 'shell', 'pm', 'path', pkg], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (!(check.stdout ?? '').trim().startsWith('package:')) {
        continue;
      }
      debug('Uninstalling stale UiAutomator2 helper APK: %s', pkg);
      spawnSync('adb', [...adb, 'shell', 'pm', 'uninstall', pkg], {
        encoding: 'utf8',
        timeout: 45_000,
      });
    }
  }

  private digitToKeycode(character: string): number {
    const digit = character.charCodeAt(0) - ZERO_CHARACTER_CODE;
    if (digit < 0 || digit > 9) {
      throw new Error(`Expected a single digit, received ${JSON.stringify(character)}`);
    }
    return ANDROID_KEYCODE_DIGIT_ZERO + digit;
  }

  private shouldShutdownOwnedEmulator(): boolean {
    return this.ownedEmulator && this.androidOptions.shutdownEmulatorOnTerminate !== false;
  }

  private shouldPersistEmulatorSession(scrapeSuccess: boolean): boolean {
    if (!scrapeSuccess || !this.ownedEmulator || !this.startedAvdName) {
      return false;
    }
    if (this.androidOptions.persistEmulatorSession === false) {
      return false;
    }
    if (process.env.ANDROID_NO_SESSION_SNAPSHOT === '1') {
      return false;
    }
    if (this.bootedFromSessionSnapshot) {
      debug('Booted from existing session snapshot; skipping re-save');
      return false;
    }
    return true;
  }

  private resolveSnapshotNamesForAvd(avdName: string) {
    const explicitSnapshot = this.androidOptions.snapshotName ?? process.env.ANDROID_SNAPSHOT_NAME;
    const forceBaseline =
      this.androidOptions.forceBaselineSnapshot === true || process.env.ANDROID_FORCE_BASELINE === '1';
    return resolveEmulatorSnapshotNames({
      avdName,
      explicitSnapshotName: explicitSnapshot,
      baselineSnapshotName:
        this.androidOptions.baselineSnapshotName ??
        process.env.ANDROID_BASELINE_SNAPSHOT_NAME ??
        DEFAULT_ANDROID_BASELINE_SNAPSHOT,
      sessionSnapshotName:
        this.androidOptions.sessionSnapshotName ??
        process.env.ANDROID_SESSION_SNAPSHOT_NAME ??
        DEFAULT_ANDROID_SESSION_SNAPSHOT,
      forceBaselineSnapshot: forceBaseline,
    });
  }

  private async saveEmulatorSessionSnapshot(): Promise<boolean> {
    const avdName = this.startedAvdName;
    if (!avdName) {
      return false;
    }

    const serial = this.startedEmulatorSerial ?? listAttachedEmulatorSerials()[0];
    if (!serial) {
      return false;
    }

    const { sessionSnapshot } = this.resolveSnapshotNamesForAvd(avdName);
    spawnSync('adb', ['-s', serial, 'shell', 'sync'], {
      encoding: 'utf8',
      timeout: 30_000,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.stepLog('android.snapshot.save', {
        snapshot: sessionSnapshot,
        avdName,
        attempt,
      });
      const r = spawnSync('adb', ['-s', serial, 'emu', 'avd', 'snapshot', 'save', sessionSnapshot], {
        encoding: 'utf8',
        timeout: SESSION_SNAPSHOT_SAVE_TIMEOUT_MS,
      });
      if (r.status === 0 && emulatorSnapshotExists(avdName, sessionSnapshot)) {
        this.stepLog('android.snapshot.saved', {
          snapshot: sessionSnapshot,
          avdName,
        });
        return true;
      }
      if (attempt < 3) {
        await sleep(2_000);
      }
    }

    this.stepLog('android.snapshot.save_failed', {
      snapshot: sessionSnapshot,
      avdName,
    });
    return false;
  }

  private shutdownOwnedEmulator(): void {
    const serial = this.startedEmulatorSerial ?? listAttachedEmulatorSerials()[0];
    if (serial) {
      spawnSync('adb', ['-s', serial, 'emu', 'kill'], {
        encoding: 'utf8',
        timeout: EMULATOR_SHUTDOWN_TIMEOUT_MS,
      });
    }
    if (this.emulatorProcess?.pid && !this.emulatorProcess.killed) {
      try {
        process.kill(-this.emulatorProcess.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(this.emulatorProcess.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }

  private stopOwnedAppium(): void {
    if (this.ownedAppium && this.appiumProcess && !this.appiumProcess.killed) {
      this.appiumProcess.kill('SIGTERM');
    }
  }

  private emergencyShutdown(): void {
    if (this.terminateFinished) {
      return;
    }
    this.terminateFinished = true;
    unregisterAndroidProcessCleanup(this.cleanupRegistrationId);
    void this.driver?.deleteSession().catch(() => undefined);
    this.stopOwnedAppium();
    if (this.shouldShutdownOwnedEmulator()) {
      this.shutdownOwnedEmulator();
    }
    this.emulatorProcess = undefined;
  }

  private registerProcessCleanup(): void {
    registerAndroidProcessCleanup(this.cleanupRegistrationId, () => {
      this.emergencyShutdown();
    });
  }

  private isEmulatorRunning(): boolean {
    try {
      const output = execSync('adb devices', {
        encoding: 'utf8',
        timeout: 5_000,
      });
      return output.split('\n').some(line => /^emulator-\d+\s+device$/.test(line.trim()));
    } catch {
      return false;
    }
  }

  private detectFirstAvd(): string | undefined {
    try {
      const output = execSync('emulator -list-avds', {
        encoding: 'utf8',
        timeout: 5_000,
      });
      return output.trim().split('\n').filter(Boolean)[0];
    } catch {
      return undefined;
    }
  }

  private async waitForEmulatorBoot(): Promise<void> {
    const deadline = Date.now() + EMULATOR_BOOT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.isEmulatorRunning()) {
        break;
      }
      await sleep(2_000);
    }

    while (Date.now() < deadline) {
      const r = spawnSync('adb', [...adbDeviceTargetArgs(), 'shell', 'getprop', 'sys.boot_completed'], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      if ((r.stdout ?? '').trim() === '1') {
        return;
      }
      await sleep(2_000);
    }

    throw new Error(`Android emulator did not finish booting within ${EMULATOR_BOOT_TIMEOUT_MS / 1_000}s`);
  }

  private async ensureEmulatorRunning(): Promise<void> {
    if (this.isEmulatorRunning()) {
      this.startedEmulatorSerial = listAttachedEmulatorSerials()[0];
      return;
    }

    const avdName = this.androidOptions.avdName ?? this.detectFirstAvd();
    if (!avdName) {
      throw new Error('No Android emulator is running and no AVD was found.');
    }

    debug('Starting emulator: %s', avdName);
    const emulatorArgs = ['-avd', avdName];
    if (process.env.DEBUG_ANDROID_EMULATOR_GUI !== '1') {
      emulatorArgs.push('-no-window');
    }
    this.startedAvdName = avdName;

    if (process.env.ANDROID_COLD_BOOT === '1') {
      emulatorArgs.push('-no-snapshot-load', '-no-snapshot-save');
    } else {
      const { loadSnapshot, sessionSnapshot, baselineSnapshot } = this.resolveSnapshotNamesForAvd(avdName);
      const sessionReady = emulatorSnapshotExists(avdName, sessionSnapshot);
      this.bootedFromSessionSnapshot = loadSnapshot === sessionSnapshot;
      this.stepLog('android.snapshot.load', {
        avdName,
        loadSnapshot,
        sessionSnapshot,
        baselineSnapshot,
        sessionReady,
        bootedFromSessionSnapshot: this.bootedFromSessionSnapshot,
      });
      emulatorArgs.push('-snapshot', loadSnapshot, '-no-snapshot-save');
    }

    const proc = spawn('emulator', emulatorArgs, {
      detached: true,
      stdio: 'ignore',
    });
    this.emulatorProcess = proc;
    this.registerProcessCleanup();
    proc.unref();

    await this.waitForEmulatorBoot();
    this.ownedEmulator = true;
    this.startedEmulatorSerial = listAttachedEmulatorSerials()[0];
  }

  private async isAppiumAlive(): Promise<boolean> {
    try {
      const res = await fetch(`http://${APPIUM_HOST}:${this.resolvedAppiumPort}/status`);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async ensureAppiumRunning(): Promise<void> {
    if (await this.isAppiumAlive()) {
      return;
    }

    debug('Starting Appium server on port %d', this.resolvedAppiumPort);
    this.appiumProcess = spawn('appium', ['server', '--port', String(this.resolvedAppiumPort)], { stdio: 'ignore' });
    this.ownedAppium = true;
    this.registerProcessCleanup();

    const deadline = Date.now() + APPIUM_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isAppiumAlive()) {
        return;
      }
      await sleep(1_000);
    }
    throw new Error(`Appium server did not become ready within ${APPIUM_READY_TIMEOUT_MS / 1_000}s`);
  }
}
