# Android app scrapers (`BaseAndroidAppScraper`)

Some institutions have no usable web interface, and only a mobile app so they need to be scraped by driving the native Android app inside an emulator via [Appium](https://appium.io/) and the UiAutomator2 driver.

`BaseAndroidAppScraper` owns all generic plumbing: emulator boot, Appium session lifecycle, snapshots, and shared element/interaction helpers. only implement `appPackage`, `login()`, and `fetchData()`.

## Related files

| File                                       | Responsibility                                   |
| ------------------------------------------ | ------------------------------------------------ |
| `base-android-app-scraper.ts`              | Base class: boot, Appium, snapshots, UI helpers. |
| `../helpers/android-adb.ts`                | Shared adb/device helpers.                       |
| `../helpers/android-emulator-snapshots.ts` | Snapshot name resolution and existence checks.   |
| `../helpers/android-launcher.ts`           | Resolve an app's launcher activity.              |
| `../helpers/android-process-cleanup.ts`    | Kill owned emulator/Appium processes on exit.    |

## Prerequisites

1. **Android SDK platform-tools** (`adb`) and **emulator** on your `PATH`.

- Verify: `adb version` and `emulator -version`.

2. **A Java JDK** (required by Appium's UiAutomator2 driver).
3. **An Android Virtual Device (AVD)**.

- List existing AVDs: `emulator -list-avds`.
- note: The scraper boots the first AVD found unless you pass `avdName`.

4. **Appium 2 + the UiAutomator2 driver**:

```bash
 bun add -g appium
 appium driver install uiautomator2
```

The base class auto-starts an Appium server on port `4723` if one is not already running. 5. **The target app installed in the AVD.** Install it once from the Play Store (or sideload an APK)
inside the emulator. The base class resolves the launcher activity automatically; it does **not**
install the APK for you. 6. **A baseline snapshot** named `scraper-baseline` (see below).

## Snapshots: how a run boots

To skip slow boot and (after the first login) repeated OTP flows, the base class uses emulator RAM snapshots:

- `scraper-baseline` — manually created logged-out, booted app state you create once.
  - Boot your AVD, install/open the app to a stable pre-login screen, then save it:
    ```bash
    adb emu avd snapshot save scraper-baseline
    ```
- `**scraper-session**` — created automatically after the **first successful scrape**. It captures
  the logged-in state so later runs load it and skip OTP or other first-run steps.

Boot precedence (see `resolveEmulatorSnapshotNames` in `android-emulator-snapshots.ts`): explicit
`snapshotName` → `scraper-session` (if it exists) → `scraper-baseline`.

Override snapshot names with constructor options or env vars (see table below).

## Constructor options and environment variables

| Option (constructor)          | Env var                                      | Effect                                                                      |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| `avdName`                     | —                                            | Which AVD to boot.                                                          |
| `appiumPort`                  | —                                            | Appium port (default `4723`).                                               |
| `shutdownEmulatorOnTerminate` | —                                            | Kill the emulator on terminate (default `true` when the scraper booted it). |
| `persistEmulatorSession`      | `ANDROID_NO_SESSION_SNAPSHOT=1` (to disable) | Save `scraper-session` after success (default `true`).                      |
| `forceBaselineSnapshot`       | `ANDROID_FORCE_BASELINE=1`                   | Ignore `scraper-session` and boot from baseline (forces re-login/OTP).      |
| `snapshotName`                | `ANDROID_SNAPSHOT_NAME`                      | Explicit snapshot to load.                                                  |
| `baselineSnapshotName`        | `ANDROID_BASELINE_SNAPSHOT_NAME`             | Override default baseline name (`scraper-baseline`).                        |
| `sessionSnapshotName`         | `ANDROID_SESSION_SNAPSHOT_NAME`              | Override default session name (`scraper-session`).                          |
| —                             | `ANDROID_COLD_BOOT=1`                        | Cold boot (no snapshot load/save).                                          |
| —                             | `DEBUG_ANDROID_EMULATOR_GUI=1`               | Show the emulator window (otherwise `-no-window`).                          |
| —                             | `ANDROID_SERIAL`                             | Target a specific device when several are attached.                         |
| —                             | `DEBUG=israeli-bank-scrapers:`\*             | Enable debug + step logs.                                                   |

## Implementing a new emulator-based scraper

1. **Add the company** to `CompanyTypes` and `SCRAPERS` in `src/definitions.ts`, and wire it into
   `src/scrapers/factory.ts`.
2. **Create a folder** `src/scrapers/<company>/` with:

- `<company>-selectors.ts` (or `-consts.ts`) — package name, selectors, regexes, coordinates.
- `<company>-types.ts` — credentials and any result types.
- `<company>-parsing.ts` (+ test) — pure parsing with no Appium, for fast unit tests.
- `<company>.ts` — the scraper class.
- `README.md` — institution-specific setup, credentials, and diagnostics.

3. **Extend the base class** and implement the abstract/overridable surface:

```ts
export default class MyScraper extends BaseAndroidAppScraper<MyCredentials> {
  get appPackage(): string {
    return 'com.example.app';
  }

  // Override only if the launcher activity cannot be auto-resolved.
  protected launcherActivityExplicit(): string | undefined {
    return undefined;
  }

  // Optional: navigate to a stable screen before the session snapshot is saved.
  protected override async prepareEmulatorSnapshotState(): Promise<void> {
    this.spawnAdb(['am', 'force-stop', this.appPackage]);
    await sleep(600);
  }

  async login(credentials: MyCredentials): Promise<ScraperLoginResult> {
    /* ... */
  }
  async fetchData(): Promise<ScraperScrapingResult> {
    /* ... */
  }
}
```

4. **Reuse base helpers** instead of re-implementing them:

- Waiting/visibility: `waitFor`, `waitForFirst`, `isDisplayed`, `isAnyDisplayed`, `waitForCondition`.
- Interaction: `tap`, `tapFirst`, `typeInto`, `typeIntoFirst`, `tapByCoordinates`,
  `pressDigitsViaAdbKeyevent`.
- Reading: `readAccessibleText`, `readAndroidClipboardPlaintext`.
- Process: `spawnAdb`, `activateApp` (called automatically during `initialize`).
- Logging: `stepLog(event, detail)` — emits structured step events when `verbose: true` or
  `DEBUG=israeli-bank-scrapers:steps` is set.

The base class is **success-tailed**: UI helpers do not wrap operations in session-recovery
retries. Fail fast so the static flow can be adjusted when the app UI changes.

## Example scraper

See [Pepper](./pepper/README.md) for a full implementation and local test harness.
