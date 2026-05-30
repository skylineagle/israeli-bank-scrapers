import { execSync, spawnSync } from 'child_process';

const ADB_DEVICES_TIMEOUT_MS = 8_000;
const DEFAULT_ADB_SHELL_TIMEOUT_MS = 10_000;
const ADB_SHELL_MAX_BUFFER_BYTES = 1024 * 1024;

function readAdbDevicesLines(timeoutMs: number): string[] {
  try {
    const output = execSync('adb devices', { encoding: 'utf8', timeout: timeoutMs });
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Serials of every attached adb target (emulators and physical devices) reporting `device` state. */
export function listAdbDeviceSerials(): string[] {
  return readAdbDevicesLines(2_000)
    .filter(line => /\S+\s+device$/.test(line) && !line.startsWith('List'))
    .map(line => line.split(/\s+/)[0]);
}

/** Serials of attached emulators only (lines matching `emulator-<port>`). */
export function listAttachedEmulatorSerials(): string[] {
  return readAdbDevicesLines(ADB_DEVICES_TIMEOUT_MS)
    .filter(line => /^emulator-\d+\s+device$/.test(line))
    .map(line => line.split(/\s+/)[0]);
}

/**
 * Build the `-s <serial>` prefix that targets a single device.
 * Honours ANDROID_SERIAL, otherwise targets the sole attached device when exactly one exists.
 */
export function adbDeviceTargetArgs(): string[] {
  const serialFromEnv = process.env.ANDROID_SERIAL?.trim();
  if (serialFromEnv) {
    return ['-s', serialFromEnv];
  }
  const serials = listAdbDeviceSerials();
  return serials.length === 1 ? ['-s', serials[0]] : [];
}

/** Run `adb shell <args>` against the resolved device and return combined stdout+stderr (trimmed). */
export function runAdbShell(
  shellArgs: readonly string[],
  options: { timeoutMs?: number; maxBufferBytes?: number } = {},
): string {
  const result = spawnSync('adb', [...adbDeviceTargetArgs(), 'shell', ...shellArgs], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_ADB_SHELL_TIMEOUT_MS,
    maxBuffer: options.maxBufferBytes ?? ADB_SHELL_MAX_BUFFER_BYTES,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}
