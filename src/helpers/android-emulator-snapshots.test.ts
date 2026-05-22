import { mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  DEFAULT_ANDROID_BASELINE_SNAPSHOT,
  DEFAULT_ANDROID_SESSION_SNAPSHOT,
  emulatorSnapshotExists,
  resolveEmulatorSnapshotName,
  resolveEmulatorSnapshotNames,
} from './android-emulator-snapshots';

const TEST_AVD = '__ibs_snapshot_test_avd__';

function testAvdDir(): string {
  return join(homedir(), '.android', 'avd', `${TEST_AVD}.avd`);
}

function testSnapshotDir(snapshotName: string): string {
  return join(testAvdDir(), 'snapshots', snapshotName);
}

describe('android-emulator-snapshots', () => {
  beforeAll(() => {
    mkdirSync(testSnapshotDir(DEFAULT_ANDROID_BASELINE_SNAPSHOT), { recursive: true });
  });

  afterAll(() => {
    rmSync(testAvdDir(), { recursive: true, force: true });
  });

  it('detects an existing snapshot directory', () => {
    expect(emulatorSnapshotExists(TEST_AVD, DEFAULT_ANDROID_BASELINE_SNAPSHOT)).toBe(true);
    expect(emulatorSnapshotExists(TEST_AVD, 'missing-snapshot')).toBe(false);
  });

  it('prefers session snapshot when present', () => {
    mkdirSync(testSnapshotDir(DEFAULT_ANDROID_SESSION_SNAPSHOT), { recursive: true });
    expect(
      resolveEmulatorSnapshotName({
        avdName: TEST_AVD,
      }),
    ).toBe(DEFAULT_ANDROID_SESSION_SNAPSHOT);
    expect(
      resolveEmulatorSnapshotNames({
        avdName: TEST_AVD,
      }).loadSnapshot,
    ).toBe(DEFAULT_ANDROID_SESSION_SNAPSHOT);
    rmSync(testSnapshotDir(DEFAULT_ANDROID_SESSION_SNAPSHOT), { recursive: true, force: true });
  });

  it('falls back to baseline when session is absent', () => {
    expect(
      resolveEmulatorSnapshotName({
        avdName: TEST_AVD,
      }),
    ).toBe(DEFAULT_ANDROID_BASELINE_SNAPSHOT);
  });

  it('honors explicit snapshot override', () => {
    expect(
      resolveEmulatorSnapshotName({
        avdName: TEST_AVD,
        explicitSnapshotName: 'custom',
      }),
    ).toBe('custom');
  });

  it('forces baseline when requested', () => {
    mkdirSync(testSnapshotDir(DEFAULT_ANDROID_SESSION_SNAPSHOT), { recursive: true });
    expect(
      resolveEmulatorSnapshotName({
        avdName: TEST_AVD,
        forceBaselineSnapshot: true,
      }),
    ).toBe(DEFAULT_ANDROID_BASELINE_SNAPSHOT);
    rmSync(testSnapshotDir(DEFAULT_ANDROID_SESSION_SNAPSHOT), { recursive: true, force: true });
  });
});
