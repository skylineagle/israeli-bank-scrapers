import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const DEFAULT_ANDROID_BASELINE_SNAPSHOT = 'scraper-baseline';
export const DEFAULT_ANDROID_SESSION_SNAPSHOT = 'scraper-session';

function avdBaseDirectory(): string {
  const fromEnv = process.env.ANDROID_AVD_HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(homedir(), '.android', 'avd');
}

function avdDataDirectory(avdName: string): string {
  return join(avdBaseDirectory(), `${avdName}.avd`);
}

export function emulatorSnapshotExists(avdName: string, snapshotName: string): boolean {
  const snapshotDir = join(avdDataDirectory(avdName), 'snapshots', snapshotName);
  return existsSync(snapshotDir);
}

export type ResolveEmulatorSnapshotInput = {
  avdName: string;
  baselineSnapshotName?: string;
  sessionSnapshotName?: string;
  explicitSnapshotName?: string;
  forceBaselineSnapshot?: boolean;
};

export function resolveEmulatorSnapshotNames(input: ResolveEmulatorSnapshotInput): {
  loadSnapshot: string;
  sessionSnapshot: string;
  baselineSnapshot: string;
} {
  const baseline = input.baselineSnapshotName?.trim() || DEFAULT_ANDROID_BASELINE_SNAPSHOT;
  const session = input.sessionSnapshotName?.trim() || DEFAULT_ANDROID_SESSION_SNAPSHOT;

  if (input.explicitSnapshotName?.trim()) {
    const loadSnapshot = input.explicitSnapshotName.trim();
    return { loadSnapshot, sessionSnapshot: session, baselineSnapshot: baseline };
  }

  if (input.forceBaselineSnapshot) {
    return { loadSnapshot: baseline, sessionSnapshot: session, baselineSnapshot: baseline };
  }

  const loadSnapshot = emulatorSnapshotExists(input.avdName, session) ? session : baseline;
  return { loadSnapshot, sessionSnapshot: session, baselineSnapshot: baseline };
}

export function resolveEmulatorSnapshotName(input: ResolveEmulatorSnapshotInput): string {
  return resolveEmulatorSnapshotNames(input).loadSnapshot;
}
