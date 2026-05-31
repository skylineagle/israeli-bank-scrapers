import { execSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { remote, type Browser } from 'webdriverio';
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
import { type AndroidScraperOptions, type ScraperCredentials } from './interface';

const debug = getDebug('android-app-scraper');
const stepsDebug = getDebug('steps');

const APPIUM_HOST = 'localhost';
const DEFAULT_APPIUM_PORT = 4723;
const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_CONDITION_POLL_MS = 350;
const SCROLL_DURATION_MS = 600;
const EMULATOR_BOOT_TIMEOUT_MS = 180_000;
const APPIUM_READY_TIMEOUT_MS = 30_000;
const EMULATOR_SHUTDOWN_TIMEOUT_MS = 20_000;
const SESSION_SNAPSHOT_SAVE_TIMEOUT_MS = 45_000;
const KEYCODE_BACK = 4;
const ANDROID_KEYCODE_DIGIT_ZERO = 7; // KEYCODE_0; the keycode for digit n is ANDROID_KEYCODE_DIGIT_ZERO + n.
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

export abstract class BaseAndroidAppScraper<TCredentials extends ScraperCredentials> extends BaseScraper<TCredentials> {
  protected driver!: Browser;

  private appiumProcess?: ChildProcess;
  private ownedAppium = false;

  private cachedCapabilities?: AppiumCapabilities;

  private ownedEmulator = false;

  private emulatorProcess?: ChildProcess;

  private cleanupRegistrationId = randomUUID();

  private terminateFinished = false;

  private startedEmulatorSerial?: string;

  private startedAvdName?: string;

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

  private resetStaleUiAutomator2Servers(): void {
    const adb = adbDeviceTargetArgs();
    const pkgs = ['io.appium.uiautomator2.server', 'io.appium.uiautomator2.server.test'];
    for (const pkg of pkgs) {
      const check = spawnSync('adb', [...adb, 'shell', 'pm', 'path', pkg], { encoding: 'utf8', timeout: 10_000 });
      if (!(check.stdout ?? '').trim().startsWith('package:')) {
        debug('UiAutomator2 helper %s not installed, skipping uninstall', pkg);
        continue;
      }
      debug('Uninstalling stale UiAutomator2 helper APK: %s', pkg);
      spawnSync('adb', [...adb, 'shell', 'am', 'force-stop', pkg], { encoding: 'utf8', timeout: 20_000 });
      const r = spawnSync('adb', [...adb, 'shell', 'pm', 'uninstall', pkg], { encoding: 'utf8', timeout: 45_000 });
      debug('pm uninstall %s exit=%s', pkg, String(r.status));
    }
  }

  private webDriverErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return `${err.message}\n${err.stack ?? ''}`;
    }
    if (err && typeof err === 'object' && 'message' in err) {
      return String((err as { message: unknown }).message);
    }
    return String(err);
  }

  private isRecoverableWebDriverInfrastructureFailure(message: string): boolean {
    const m = message.toLowerCase();
    return (
      m.includes('uiautomation') ||
      m.includes('ui automation') ||
      m.includes('illegalstateexception') ||
      m.includes('instrumentation process is not running') ||
      m.includes('cannot be proxied to uiautomator2') ||
      (m.includes('instrumentation') && (m.includes('crash') || m.includes('not running'))) ||
      m.includes('instrumentationrunner') ||
      m.includes('could not proxy command') ||
      m.includes('socket hang up') ||
      m.includes('econnrefused') ||
      m.includes('invalid session id') ||
      (m.includes('session') && m.includes('terminated')) ||
      (m.includes('new session') && m.includes('could not'))
    );
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

  private prepareEmulatorForSnapshotSave(serial: string): void {
    spawnSync('adb', ['-s', serial, 'shell', 'sync'], { encoding: 'utf8', timeout: 30_000 });
  }

  private async saveEmulatorSessionSnapshot(): Promise<boolean> {
    const avdName = this.startedAvdName;
    if (!avdName) {
      debug('No AVD name recorded; skipping session snapshot save');
      return false;
    }

    const serial = this.startedEmulatorSerial ?? listAttachedEmulatorSerials()[0];
    if (!serial) {
      debug('No emulator serial; skipping session snapshot save');
      return false;
    }

    const { sessionSnapshot } = this.resolveSnapshotNamesForAvd(avdName);
    this.prepareEmulatorForSnapshotSave(serial);

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      debug(
        'Saving emulator session snapshot "%s" on %s (attempt %d/%d)',
        sessionSnapshot,
        serial,
        attempt,
        maxAttempts,
      );
      this.stepLog('android.snapshot.save', { snapshot: sessionSnapshot, avdName, attempt });

      const r = spawnSync('adb', ['-s', serial, 'emu', 'avd', 'snapshot', 'save', sessionSnapshot], {
        encoding: 'utf8',
        timeout: SESSION_SNAPSHOT_SAVE_TIMEOUT_MS,
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
      if (r.status !== 0) {
        debug('Session snapshot save failed (exit %s): %s', String(r.status), out.slice(0, 400));
        if (attempt < maxAttempts) {
          await sleep(2_000);
        }
        continue;
      }

      if (emulatorSnapshotExists(avdName, sessionSnapshot)) {
        debug('Session snapshot "%s" saved for AVD %s', sessionSnapshot, avdName);
        this.stepLog('android.snapshot.saved', { snapshot: sessionSnapshot, avdName });
        if (this.options.verbose) {
          process.stderr.write(
            `[israeli-bank-scrapers] Saved logged-in emulator snapshot "${sessionSnapshot}" for AVD "${avdName}". Next run will boot from it and skip OTP.\n`,
          );
        }
        return true;
      }

      debug('Snapshot save command succeeded but "%s" not found on disk yet', sessionSnapshot);
    }

    this.stepLog('android.snapshot.save_failed', { snapshot: sessionSnapshot, avdName });
    if (this.options.verbose) {
      process.stderr.write(
        `[israeli-bank-scrapers] WARNING: Could not persist emulator session snapshot "${sessionSnapshot}". ` +
          `The next run may require OTP again. Check adb -s ${serial} emu avd snapshot save.\n`,
      );
    }
    return false;
  }

  private shutdownOwnedEmulator(): void {
    const serial = this.startedEmulatorSerial ?? listAttachedEmulatorSerials()[0];
    if (serial) {
      debug('adb emu kill %s (scraper-launched emulator)', serial);
      spawnSync('adb', ['-s', serial, 'emu', 'kill'], {
        encoding: 'utf8',
        timeout: EMULATOR_SHUTDOWN_TIMEOUT_MS,
      });
    }

    if (this.emulatorProcess?.pid && !this.emulatorProcess.killed) {
      debug('Sending SIGTERM to emulator pid %d', this.emulatorProcess.pid);
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
    if (!this.ownedAppium || !this.appiumProcess || this.appiumProcess.killed) {
      return;
    }
    debug('Stopping Appium server (started by scraper)');
    this.appiumProcess.kill('SIGTERM');
  }

  private emergencyShutdown(): void {
    if (this.terminateFinished) {
      return;
    }
    this.terminateFinished = true;
    unregisterAndroidProcessCleanup(this.cleanupRegistrationId);

    if (this.driver) {
      void this.driver.deleteSession().catch(() => undefined);
    }
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

  private async recoverUiAutomatorSession(): Promise<void> {
    const caps = this.cachedCapabilities;
    if (!caps) {
      throw new Error('Cannot recover WebDriver session (capabilities cache missing)');
    }

    debug('Recreating UiAutomator2 WebDriver session');
    await this.driver?.deleteSession().catch(() => undefined);
    this.resetStaleUiAutomator2Servers();
    await sleep(3_500);
    this.driver = await this.createDriverSession(caps);
    await this.ensureTargetAppForeground(caps['appium:appActivity']);
  }

  private isSessionLostFailure(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes('invalid session id') ||
      (lower.includes('session') && lower.includes('terminated')) ||
      (lower.includes('new session') && lower.includes('could not'))
    );
  }

  private async withUiAutomatorRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await operation();
      } catch (e) {
        lastErr = e;
        const message = e instanceof Error ? e.message : String(e);
        if (!this.isRecoverableWebDriverInfrastructureFailure(message) || attempt >= 2) {
          throw e;
        }

        // The first blip on a live session is usually transient (the app is mid-transition, e.g.
        // right after login). Retry without the slow session teardown + UiAutomator2 reinstall.
        // Escalate to a full session recovery only if it recurs or the session is clearly lost.
        const useLightRecovery = attempt === 0 && !this.isSessionLostFailure(message);
        this.stepLog('android.uiautomator.recover', {
          attempt: attempt + 1,
          mode: useLightRecovery ? 'light' : 'session',
          message: message.replace(/\s+/g, ' ').slice(0, 160),
        });
        if (useLightRecovery) {
          await sleep(1_500);
        } else {
          await this.recoverUiAutomatorSession();
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async createDriverSession(capabilities: AppiumCapabilities): Promise<Browser> {
    const opts = {
      hostname: APPIUM_HOST,
      port: this.resolvedAppiumPort,
      capabilities,
      logLevel: this.options.verbose ? ('info' as const) : ('silent' as const),
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await remote(opts);
      } catch (e) {
        lastErr = e;
        const msg = this.webDriverErrorMessage(e);
        const recoverable = this.isRecoverableWebDriverInfrastructureFailure(msg);
        if (!recoverable || attempt >= 2) {
          throw e;
        }

        this.stepLog('android.session.create_retry', {
          attempt: attempt + 1,
          message: msg.replace(/\s+/g, ' ').slice(0, 160),
        });
        debug(
          'WebDriver session create failed (attempt %d/3): %s — resetting UiAutomator2 helpers',
          attempt + 1,
          msg.replace(/\s+/g, ' ').slice(0, 220),
        );
        this.resetStaleUiAutomator2Servers();
        await sleep(3_800 + attempt * 1_200);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    await this.ensureEmulatorRunning();
    await this.ensureAppiumRunning();

    const appActivity = this.launcherActivityExplicit() ?? (await resolveAndroidLauncherAppActivity(this.appPackage));

    debug('Using appPackage=%s appActivity=%s', this.appPackage, appActivity);

    const capabilities: AppiumCapabilities = {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': this.appPackage,
      'appium:appActivity': appActivity,
      'appium:noReset': true,
      'appium:newCommandTimeout': 90,
      'appium:waitAppLaunch': true,
      'appium:enforceXPath1': true,
      'appium:uiautomator2ServerInstallTimeout': 120_000,
    };

    this.cachedCapabilities = capabilities;
    if (process.env.ANDROID_SKIP_UIAUTOMATOR2_PRE_RESET !== '1') {
      debug('Pre-reset UiAutomator2 helper APKs (ANDROID_SKIP_UIAUTOMATOR2_PRE_RESET=1 to skip)');
      this.resetStaleUiAutomator2Servers();
      await sleep(2_000);
    }
    this.driver = await this.createDriverSession(capabilities);

    await this.ensureTargetAppForeground(appActivity);
    this.stepLog('android.session.ready', {
      appPackage: this.appPackage,
      appActivity,
    });
  }

  private buildAmStartComponent(appActivityCap: string): string {
    if (appActivityCap.includes('/')) {
      return appActivityCap;
    }
    const clsPart = appActivityCap.startsWith('.') ? appActivityCap : `.${appActivityCap}`;
    return `${this.appPackage}/${clsPart}`;
  }

  protected stepLog(event: string, detail?: Record<string, unknown>): void {
    const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
    const line = `${event}${suffix}`;
    stepsDebug(line);
    if (this.options.verbose) {
      process.stderr.write(`[israeli-bank-scrapers/steps][${this.options.companyId}] ${line}\n`);
    }
  }

  /**
   * Run an `adb shell` command against the connected device, returning stdout+stderr.
   * Targets the correct device when multiple are attached (see adbDeviceTargetArgs).
   */
  protected spawnAdb(shellArgs: readonly string[]): string {
    return runAdbShell(shellArgs);
  }

  protected async readForegroundPackage(): Promise<string> {
    const driverLike = this.driver as unknown as { getCurrentPackage?: () => Promise<string> };
    if (typeof driverLike.getCurrentPackage === 'function') {
      try {
        const pkg = await driverLike.getCurrentPackage.call(this.driver);
        if (pkg?.length) return pkg;
      } catch {
        /* ignore */
      }
    }

    const adbArgs = adbDeviceTargetArgs();

    try {
      const r = spawnSync('adb', [...adbArgs, 'shell', 'dumpsys', 'window', 'displays'], {
        encoding: 'utf8',
        timeout: 12_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const focusLine = (r.stdout ?? '').split('\n').find(l => l.includes('mFocusedApp=')) ?? '';
      let m = focusLine.match(/}\s+(\S+)\//);
      if (!m?.[1]) {
        m = focusLine.match(/\su\d+\s+(\S+)\//);
      }
      if (m?.[1]) return m[1];
    } catch {
      /* ignore */
    }

    try {
      const r = spawnSync('adb', [...adbArgs, 'shell', 'dumpsys', 'window'], {
        encoding: 'utf8',
        timeout: 12_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const focusLine = (r.stdout ?? '').split('\n').find(l => l.includes('mCurrentFocus')) ?? '';
      const m = focusLine.match(/\s(\S+)\/\S+/);
      return m?.[1] ?? '';
    } catch {
      return '';
    }
  }

  protected async ensureTargetAppForeground(appActivityCap: string): Promise<void> {
    await sleep(600);

    let fg = await this.readForegroundPackage();
    if (fg === this.appPackage) {
      debug('Foreground ok: %s', fg);
      return;
    }

    debug('Foreground is %s (want %s); activating...', fg || '(unknown)', this.appPackage);

    try {
      await this.driver.execute('mobile: activateApp', { appId: this.appPackage });
    } catch (e) {
      debug('mobile: activateApp failed: %s', e instanceof Error ? e.message : String(e));
    }

    await sleep(2_000);
    fg = await this.readForegroundPackage();
    if (fg === this.appPackage) {
      return;
    }

    const component = this.buildAmStartComponent(appActivityCap);
    debug('Trying adb am start -n %s', component);
    spawnSync(
      'adb',
      [
        ...adbDeviceTargetArgs(),
        'shell',
        'am',
        'start',
        '-W',
        '-c',
        'android.intent.category.LAUNCHER',
        '-n',
        component,
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );

    await sleep(2_500);
    fg = await this.readForegroundPackage();
    if (fg === this.appPackage) {
      return;
    }

    debug('Trying adb monkey (known-good manual launch)');
    spawnSync(
      'adb',
      [
        ...adbDeviceTargetArgs(),
        'shell',
        'monkey',
        '-p',
        this.appPackage,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ],
      {
        encoding: 'utf8',
        timeout: 25_000,
      },
    );

    await sleep(3_000);
    fg = await this.readForegroundPackage();
    if (fg !== this.appPackage) {
      throw new Error(
        `Could not bring ${this.appPackage} to foreground (still ${fg || 'unknown'}).\n` +
          `Last tried component ${component}; verify adb shell monkey -p ${this.appPackage} works.`,
      );
    }
    debug('Foreground ok after monkey: %s', fg);
  }

  protected async bringTargetAppToForeground(): Promise<void> {
    const caps = this.cachedCapabilities;
    if (!caps) {
      throw new Error('Cannot bring target app to foreground (session capabilities missing).');
    }
    await this.ensureTargetAppForeground(caps['appium:appActivity']);
  }

  /** Navigate app UI to a stable screen before persisting an emulator RAM snapshot (override in bank scrapers). */
  protected async prepareEmulatorSnapshotState(): Promise<void> {}

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

  private isEmulatorRunning(): boolean {
    try {
      const output = execSync('adb devices', { encoding: 'utf8', timeout: 5_000 });
      return output.split('\n').some(line => /^emulator-\d+\s+device$/.test(line.trim()));
    } catch {
      return false;
    }
  }

  private detectFirstAvd(): string | undefined {
    try {
      const output = execSync('emulator -list-avds', { encoding: 'utf8', timeout: 5_000 });
      const avds = output.trim().split('\n').filter(Boolean);
      return avds[0];
    } catch {
      return undefined;
    }
  }

  private async waitForEmulatorBoot(): Promise<void> {
    const deadline = Date.now() + EMULATOR_BOOT_TIMEOUT_MS;

    debug('Waiting for emulator to appear in adb devices…');
    while (Date.now() < deadline) {
      if (this.isEmulatorRunning()) break;
      await sleep(3_000);
    }

    debug('Waiting for Android boot to complete…');
    while (Date.now() < deadline) {
      try {
        const r = spawnSync('adb', [...adbDeviceTargetArgs(), 'shell', 'getprop', 'sys.boot_completed'], {
          encoding: 'utf8',
          timeout: 5_000,
        });
        const prop = (r.stdout ?? '').trim();
        if (prop === '1') {
          debug('Emulator boot completed');
          return;
        }
      } catch {
        // emulator not yet accepting adb commands
      }
      await sleep(3_000);
    }

    throw new Error(`Android emulator did not finish booting within ${EMULATOR_BOOT_TIMEOUT_MS / 1_000}s`);
  }

  private async ensureEmulatorRunning(): Promise<void> {
    if (this.isEmulatorRunning()) {
      debug('Emulator already running');
      this.startedEmulatorSerial = listAttachedEmulatorSerials()[0];
      return;
    }

    const avdName = this.androidOptions.avdName ?? this.detectFirstAvd();

    if (!avdName) {
      throw new Error(
        'No Android emulator is running and no AVD was found.\n' +
          'Either start an emulator manually, or set options.avdName to an existing AVD.\n' +
          'List available AVDs with: emulator -list-avds',
      );
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
      debug(
        'Booting AVD %s from snapshot "%s" (session "%s" %s)',
        avdName,
        loadSnapshot,
        sessionSnapshot,
        sessionReady ? 'exists' : 'will be created after first successful scrape',
      );
      this.stepLog('android.snapshot.load', {
        avdName,
        loadSnapshot,
        sessionSnapshot,
        baselineSnapshot,
        sessionReady,
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
    debug('Emulator ready serial=%s pid=%s', this.startedEmulatorSerial ?? 'unknown', String(proc.pid ?? 'unknown'));
  }

  private async isAppiumAlive(): Promise<boolean> {
    try {
      const res = await fetch(`http://${APPIUM_HOST}:${this.resolvedAppiumPort}/status`);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForAppium(): Promise<void> {
    const deadline = Date.now() + APPIUM_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isAppiumAlive()) {
        debug('Appium server is ready');
        return;
      }
      await sleep(1_000);
    }
    throw new Error(
      `Appium server did not become ready within ${APPIUM_READY_TIMEOUT_MS / 1_000}s.\n` +
        'Make sure appium is installed: bun add -g appium && appium driver install uiautomator2',
    );
  }

  private async ensureAppiumRunning(): Promise<void> {
    if (await this.isAppiumAlive()) {
      debug('Appium already running on port %d', this.resolvedAppiumPort);
      return;
    }

    debug('Starting Appium server on port %d', this.resolvedAppiumPort);

    this.appiumProcess = spawn('appium', ['server', '--port', String(this.resolvedAppiumPort)], {
      stdio: 'ignore',
    });
    this.ownedAppium = true;
    this.registerProcessCleanup();

    await this.waitForAppium();
  }

  private async waitForElementInner(selector: string, timeout = DEFAULT_WAIT_MS) {
    const el = this.driver.$(selector);
    await el.waitForDisplayed({ timeout });
    return el;
  }

  protected async waitForElement(selector: string, timeout = DEFAULT_WAIT_MS) {
    return this.withUiAutomatorRetry(async () => this.waitForElementInner(selector, timeout));
  }

  private async waitForAnyDisplayedInner(selectors: readonly string[], timeout = DEFAULT_WAIT_MS) {
    const deadline = Date.now() + timeout;
    let lastMessage = '';
    let iteration = 0;
    this.stepLog('waitForAnyDisplayed.start', {
      selectorCount: selectors.length,
      timeoutMs: timeout,
    });
    while (Date.now() < deadline) {
      iteration++;
      const slice = Math.min(460, Math.max(200, deadline - Date.now()));
      let selectorIndex = 0;
      for (const selector of selectors) {
        try {
          const el = this.driver.$(selector);
          await el.waitForDisplayed({ timeout: slice });
          const preview = selector.length > 140 ? `${selector.slice(0, 137)}...` : selector;
          this.stepLog('waitForAnyDisplayed.ok', {
            selectorIndex,
            iterations: iteration,
            selector: preview,
          });
          return el;
        } catch (e) {
          lastMessage = e instanceof Error ? e.message : String(e);
        }
        selectorIndex++;
      }
      const remainingMs = Math.max(0, deadline - Date.now());
      if (iteration === 1 || iteration % 5 === 0) {
        this.stepLog('waitForAnyDisplayed.retry', {
          iteration,
          remainingMs,
          lastMessage: lastMessage.slice(0, 200),
        });
      }
      await sleep(400);
    }
    this.stepLog('waitForAnyDisplayed.fail', {
      selectorCount: selectors.length,
      timeoutMs: timeout,
      lastMessage: lastMessage.slice(0, 220),
    });
    throw new Error(`None of ${selectors.length} selectors matched within ${timeout}ms (${lastMessage.slice(0, 160)})`);
  }

  protected async waitForAnyDisplayed(selectors: readonly string[], timeout = DEFAULT_WAIT_MS) {
    return this.withUiAutomatorRetry(async () => this.waitForAnyDisplayedInner(selectors, timeout));
  }

  protected async tapAny(selectors: readonly string[], timeout = DEFAULT_WAIT_MS): Promise<void> {
    return this.withUiAutomatorRetry(async () => {
      this.stepLog('tapAny.start', { selectorCount: selectors.length, timeoutMs: timeout });
      const el = await this.waitForAnyDisplayedInner(selectors, timeout);
      await el.click();
      this.stepLog('tapAny.done', { selectorCount: selectors.length });
    });
  }

  protected async typeIntoAny(selectors: readonly string[], value: string, timeout = DEFAULT_WAIT_MS): Promise<void> {
    return this.withUiAutomatorRetry(async () => {
      this.stepLog('typeIntoAny.start', {
        selectorCount: selectors.length,
        timeoutMs: timeout,
        valueLength: value.length,
      });
      const el = await this.waitForAnyDisplayedInner(selectors, timeout);
      await el.click();
      await el.clearValue().catch(() => undefined);
      await el.setValue(value);
      this.stepLog('typeIntoAny.done', { selectorCount: selectors.length, valueLength: value.length });
    });
  }

  protected async pressAndroidBack(): Promise<void> {
    await this.withUiAutomatorRetry(async () => {
      const driverLike = this.driver as unknown as {
        pressKeyCode?: (code: number, metaState?: number) => Promise<void>;
      };
      if (typeof driverLike.pressKeyCode === 'function') {
        await driverLike.pressKeyCode(KEYCODE_BACK);
        return;
      }
      await this.driver.execute('mobile: pressKey', { keycode: KEYCODE_BACK });
    });
    await sleep(350);
  }

  /**
   * Poll an async predicate until it resolves true or the timeout elapses.
   * Prefer this over fixed sleeps when waiting for an app state that has no single element to await.
   */
  protected async waitForCondition(
    predicate: () => Promise<boolean>,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_CONDITION_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return true;
      }
      await sleep(intervalMs);
    }
    return false;
  }

  /** Read the combined text + accessibility labels of an element, de-duplicated and bidi-cleaned. */
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
        /* attribute not present on this element */
      }
    }
    return stripBidirectionalAndTrim(chunks.join(' '));
  }

  /** Tap an absolute screen coordinate via `adb shell input tap` (for controls with no accessible selector). */
  protected tapByCoordinates(x: number, y: number): void {
    this.spawnAdb(['input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  }

  private digitToKeycode(character: string): number {
    const digit = character.charCodeAt(0) - ZERO_CHARACTER_CODE;
    if (digit < 0 || digit > 9) {
      throw new Error(`Expected a single digit, received ${JSON.stringify(character)}`);
    }
    return ANDROID_KEYCODE_DIGIT_ZERO + digit;
  }

  /** Type digits through the WebDriver pressKeyCode API. Throws if the driver does not support it. */
  protected async pressDigitsViaDriverKeyCode(digits: string): Promise<void> {
    const driverLike = this.driver as unknown as {
      pressKeyCode?: (code: number, metaState?: number) => Promise<void>;
    };
    if (typeof driverLike.pressKeyCode !== 'function') {
      throw new Error('driver.pressKeyCode is not available on this session');
    }
    for (const character of digits) {
      await driverLike.pressKeyCode(this.digitToKeycode(character));
    }
  }

  /** Type digits through `adb shell input keyevent`, the most reliable path for custom keyboards. */
  protected async pressDigitsViaAdbKeyevent(digits: string, perKeyDelayMs = 80): Promise<void> {
    for (const character of digits) {
      this.spawnAdb(['input', 'keyevent', String(this.digitToKeycode(character))]);
      if (perKeyDelayMs > 0) {
        // Short debounce so the input system registers each discrete keyevent.
        await sleep(perKeyDelayMs);
      }
    }
  }

  protected async readAndroidClipboardPlaintext(): Promise<string> {
    const clipboard = await this.driver.getClipboard();
    if (!clipboard || clipboard.length === 0) {
      return '';
    }

    const decoded = Buffer.from(clipboard, 'base64').toString('utf8');
    return decoded;
  }

  private async isAnyVisibleInner(selectors: readonly string[], timeout = 4_000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const slice = Math.min(480, Math.max(160, deadline - Date.now()));
      for (const selector of selectors) {
        try {
          const el = this.driver.$(selector);
          await el.waitForDisplayed({ timeout: slice });
          return true;
        } catch {
          continue;
        }
      }
      await sleep(350);
    }
    return false;
  }

  protected async isAnyVisible(selectors: readonly string[], timeout = 4_000): Promise<boolean> {
    return this.withUiAutomatorRetry(async () => this.isAnyVisibleInner(selectors, timeout));
  }

  protected async isVisible(selector: string, timeout = 3_000): Promise<boolean> {
    try {
      return await this.withUiAutomatorRetry(async () => {
        const el = this.driver.$(selector);
        await el.waitForDisplayed({ timeout });
        return true;
      });
    } catch {
      return false;
    }
  }

  protected async tap(selector: string): Promise<void> {
    return this.withUiAutomatorRetry(async () => {
      const el = await this.waitForElementInner(selector);
      await el.click();
    });
  }

  protected async tapByText(text: string): Promise<void> {
    await this.tap(`//*[@text="${text}"]`);
  }

  protected async tapByContentDesc(desc: string): Promise<void> {
    await this.tap(`//*[@content-desc="${desc}"]`);
  }

  protected async typeInto(selector: string, value: string): Promise<void> {
    return this.withUiAutomatorRetry(async () => {
      const el = await this.waitForElementInner(selector);
      await el.click();
      await el.clearValue();
      await el.setValue(value);
    });
  }

  protected async readText(selector: string): Promise<string> {
    return this.withUiAutomatorRetry(async () => {
      const el = await this.waitForElementInner(selector);
      return el.getText();
    });
  }

  protected async readAllTexts(selector: string): Promise<string[]> {
    return this.withUiAutomatorRetry(async () => {
      const elements = this.driver.$$(selector);
      const texts: string[] = [];
      for (const el of elements) {
        texts.push(await el.getText());
      }
      return texts;
    });
  }

  protected async dismissKeyboard(): Promise<void> {
    await this.withUiAutomatorRetry(async () => {
      await this.driver.hideKeyboard().catch(() => undefined);
    });
  }

  protected isAndroidKeyboardShown(): boolean {
    const out = this.spawnAdb(['dumpsys', 'input_method']);
    return out.includes('mInputShown=true');
  }

  protected async swipeUp(): Promise<void> {
    await this.withUiAutomatorRetry(async () => {
      const { width, height } = await this.driver.getWindowSize();
      const left = Math.max(1, Math.round(width * 0.12));
      const top = Math.max(1, Math.round(height * 0.18));
      const swipeWidth = Math.max(1, width - left * 2);
      const swipeHeight = Math.max(1, Math.round(height * 0.62));
      const midX = Math.round(width / 2);
      const fromY = Math.round(height * 0.72);
      const toY = Math.round(height * 0.28);

      try {
        await this.driver.execute('mobile: swipeGesture', {
          left,
          top,
          width: swipeWidth,
          height: swipeHeight,
          direction: 'up',
          percent: 0.72,
        });
      } catch (gestureErr) {
        debug(
          'mobile: swipeGesture failed (%s); using performActions',
          gestureErr instanceof Error ? gestureErr.message.slice(0, 140) : String(gestureErr),
        );
        await this.driver.performActions([
          {
            type: 'pointer',
            id: 'finger_swipe_up',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: midX, y: fromY },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: SCROLL_DURATION_MS },
              { type: 'pointerMove', duration: SCROLL_DURATION_MS, x: midX, y: toY },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ]);
        await this.driver.releaseActions().catch(() => undefined);
      }

      await sleep(280);
    });
  }

  protected async getChildTexts(parentSelector: string): Promise<string[]> {
    return this.withUiAutomatorRetry(async () => {
      const parent = await this.waitForElementInner(parentSelector);
      const children = parent.$$('android.widget.TextView');
      const texts: string[] = [];
      for (const child of children) {
        const text = await child.getText();
        if (text) {
          texts.push(text);
        }
      }
      return texts;
    });
  }
}
