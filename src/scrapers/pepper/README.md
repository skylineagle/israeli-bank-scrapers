# Pepper scraper

Pepper has no usable web interface. This scraper drives the native Pepper Android app inside an
emulator via `BaseAndroidAppScraper`.

For emulator boot, Appium setup, RAM snapshots, and shared Android options, see
[base-android-app-scraper.md](../base-android-app-scraper.md).

## File layout

| File | Responsibility |
| --- | --- |
| `pepper.ts` | Scraper: `login()`, `fetchData()`, and dashboard probe orchestration. |
| `pepper-selectors.ts` | Package name, phone country code, UI selectors, regexes, screen coordinates. |
| `pepper-types.ts` | `PepperCredentials`, `PepperAccountTotals`, `PepperDashboardProbeResult`. |
| `pepper-parsing.ts` | Pure text/amount/account/phone parsing (unit-tested, no Appium). |
| `pepper-parsing.test.ts` | Unit tests for the parsing module. |
| `pepper.test.ts` | Integration tests (login + scrape) via Jest; see CONTRIBUTING.md. |

## Pepper-specific setup

1. Complete the [Android emulator prerequisites](../base-android-app-scraper.md#prerequisites).
2. **Install the Pepper app** in your AVD from the Play Store (`com.pepper.ldb`).
3. **Create `scraper-baseline`** with Pepper open on the login screen:
   ```bash
   adb emu avd snapshot save scraper-baseline
   ```

## Credentials

```ts
type PepperCredentials = {
  phoneNumber: string; // Israeli mobile, e.g. 0501234567
  password: string;
  otpCodeRetriever?: () => Promise<string>; // called when SMS OTP is required
};
```

`otpCodeRetriever` is only invoked when the app shows the OTP screen (typically on the first run
after loading `scraper-baseline`, or when `ANDROID_FORCE_BASELINE=1` resets the session snapshot).

## Running

```ts
import { CompanyTypes, PepperScraper } from 'israeli-bank-scrapers';

const scraper = new PepperScraper({
  companyId: CompanyTypes.pepper,
  startDate: new Date('2025-01-01'),
  avdName: 'Pixel_9_API_35', // optional; defaults to the first AVD
  shutdownEmulatorOnTerminate: true,
  verbose: true, // stream step logs to stderr
});

const result = await scraper.scrape({
  phoneNumber: '0501234567',
  password: 'secret',
  otpCodeRetriever: async () => promptUserForSmsCode(),
});
```

### Running integration tests

Uncomment `pepper` credentials in `src/tests/.tests-config.js` (from `.tests-config.tpl.js`), then:

```bash
npm test -- pepper.test.ts
```

When SMS OTP is required, enter the code at the prompt or set `PEPPER_OTP`. Optional: `PEPPER_AVD=Pixel_9_API_35`
to pick a specific AVD.

Android snapshot and emulator options (`ANDROID_FORCE_BASELINE`, `ANDROID_NO_SESSION_SNAPSHOT`, etc.)
are documented in [base-android-app-scraper.md](../base-android-app-scraper.md#constructor-options-and-environment-variables).

## Diagnosing selector drift (the probe)

Pepper's RTL React Native UI exposes balances inconsistently, so `fetchData()` tries several
strategies per value and logs which one succeeded via `stepLog` (`pepper.balance.resolved`,
`pepper.foreignCurrency.resolved`, …). Run with `verbose: true` or
`DEBUG=israeli-bank-scrapers:steps` to see the winning path.

`runProbeSession()` returns a structured `PepperDashboardProbeResult` that dumps every candidate
node and balance attempt — use it when the UI changes and reads start failing:

Call `runProbeSession()` from a small script or REPL with the same credentials you use in tests.

The probe reports:

- **`homeMarkers`** — whether key dashboard markers are visible.
- **`shekelMatchingNodeCount` / `topShekelSamples`** — nodes matching shekel balance patterns.
- **`balanceAttempts`** — each balance-reading path tried and its result or error.
- **`foreignPivotScanCount` / `foreignBroadScanCount`** — foreign-currency balance discovery stats.
