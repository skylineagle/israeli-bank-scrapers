import { execFileSync, spawnSync } from 'child_process';

const sleepMs = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function adbShellOutput(args: readonly string[]): string {
  const r = spawnSync('adb', ['shell', ...args], {
    encoding: 'utf8',
    timeout: 35_000,
    maxBuffer: 12 * 1024 * 1024,
  });

  const stdout = (r.stdout ?? '').trim();
  const stderr = (r.stderr ?? '').trim();
  return [stdout, stderr].filter(Boolean).join('\n');
}

function parseCmpFromBriefOrQueryOutput(output: string, packageName: string): string | undefined {
  const text = output.trim();
  if (!text || /no activity found|Unable to find/i.test(text)) {
    return undefined;
  }

  const cmpEquals = text.match(/\bcmp=([^\s\}\]]+)/);
  if (cmpEquals?.[1]?.startsWith(`${packageName}/`)) {
    return cmpEquals[1];
  }

  const cmpInIntent = text.match(/cmp=([^\s\}\]]+)/g);
  if (cmpInIntent?.length) {
    for (const m of cmpInIntent) {
      const val = m.replace(/^cmp=/, '');
      if (val.startsWith(`${packageName}/`)) return val;
    }
  }

  const componentInfo = text.match(/ComponentInfo\{([^}]+)\}/);
  if (componentInfo?.[1]?.startsWith(`${packageName}/`)) {
    return componentInfo[1];
  }

  const lineComponent = text.match(new RegExp(`\\b${packageName.replace(/\./g, '\\.')}\\/[^\\s/][^\\s]*`, 'g'));
  return lineComponent?.[0];
}

function tryResolveViaPackageCmd(args: readonly string[], packageName: string): string | undefined {
  const out = adbShellOutput(['cmd', 'package', ...args]);
  return parseCmpFromBriefOrQueryOutput(out, packageName);
}

function parseMainLauncherActivitiesFromDump(dump: string, packageName: string): string[] {
  const escaped = packageName.replace(/\./g, '\\.');
  const results: string[] = [];

  const mainBlockMarkers = ['android.intent.action.MAIN:', "'android.intent.action.MAIN':"];

  let searchFrom = 0;
  while (searchFrom < dump.length) {
    let mainStart = -1;
    let usedMarkerLen = 0;
    for (const m of mainBlockMarkers) {
      const idx = dump.indexOf(m, searchFrom);
      if (idx >= 0 && (mainStart < 0 || idx < mainStart)) {
        mainStart = idx;
        usedMarkerLen = m.length;
      }
    }
    if (mainStart < 0) break;

    const blockStart = mainStart + usedMarkerLen;
    const nextAction = dump.slice(blockStart).search(/\n\s+android\.intent\.action\.\w+:/);
    const blockEnd = nextAction >= 0 ? blockStart + nextAction : Math.min(blockStart + 12_000, dump.length);
    const block = dump.slice(blockStart, blockEnd);

    const lineRe = new RegExp(`^\\s+\\S+\\s+(${escaped}/\\S+)\\s+filter\\s`, 'gm');
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(block)) !== null) {
      const cmp = m[1].split(/\s/)[0];
      if (cmp?.startsWith(`${packageName}/`)) {
        results.push(cmp);
      }
    }

    searchFrom = blockEnd;
  }

  return results;
}

function pickLauncherCandidate(candidates: string[], dump: string): string | undefined {
  if (!candidates.length) return undefined;
  const withLauncher = candidates.filter(c => {
    const idx = dump.indexOf(c);
    if (idx < 0) return false;
    const ctx = dump.slice(Math.max(0, idx - 400), Math.min(dump.length, idx + 800));
    return ctx.includes('android.intent.category.LAUNCHER');
  });
  return (withLauncher.length ? withLauncher : candidates)[0];
}

function cmpFromDumpFallback(packageName: string): string | undefined {
  let dump: string;
  try {
    dump = execFileSync('adb', ['shell', 'dumpsys', 'package', packageName], {
      encoding: 'utf8',
      timeout: 55_000,
      maxBuffer: 30 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }

  const fromMain = parseMainLauncherActivitiesFromDump(dump, packageName);
  const picked = pickLauncherCandidate(fromMain, dump);
  if (picked) return picked;

  const looseRe = new RegExp(`(${packageName.replace(/\./g, '\\.')}/\\S+)\\s+filter\\s`, 'g');
  const loose: string[] = [];
  let lm: RegExpExecArray | null;
  while ((lm = looseRe.exec(dump)) !== null) {
    const cmp = lm[1].split(/\s/)[0];
    if (cmp.startsWith(`${packageName}/`)) loose.push(cmp);
  }
  return pickLauncherCandidate(loose, dump);
}

async function cmpFromMonkeyAndTopActivity(packageName: string): Promise<string | undefined> {
  spawnSync('adb', ['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], {
    encoding: 'utf8',
    timeout: 25_000,
  });

  await sleepMs(2_000);

  let top = '';
  let activities = '';

  try {
    top = execFileSync('adb', ['shell', 'dumpsys', 'activity', 'top'], {
      encoding: 'utf8',
      timeout: 25_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    top = '';
  }

  try {
    activities = execFileSync('adb', ['shell', 'dumpsys', 'activity', 'activities'], {
      encoding: 'utf8',
      timeout: 25_000,
      maxBuffer: 6 * 1024 * 1024,
    });
  } catch {
    activities = '';
  }

  const haystack = `${top}\n${activities}`;
  const pkgEsc = packageName.replace(/\./g, '\\.');
  const patterns = [
    new RegExp(`TopResumedActivity[^\\n]*\\s(${pkgEsc}/\\S+)`, 'i'),
    new RegExp(`ACTIVITY\\s+(${pkgEsc}/\\S+)`, 'i'),
    new RegExp(`ResumedActivity:\\s*ActivityRecord\\{[^}]*\\s(${pkgEsc}/\\S+)`, 'i'),
    new RegExp(`mResumedActivity:\\s*ActivityRecord\\{[^}]*\\s(${pkgEsc}/\\S+)`, 'i'),
    new RegExp(`mCurrentFocus[^\\n]*\\s(${pkgEsc}/\\S+)`, 'i'),
    new RegExp(`ActivityRecord\\{[^}]*\\b(${pkgEsc}/\\S+)`, 'i'),
  ];

  for (const re of patterns) {
    const m = haystack.match(re);
    const raw = m?.[1];
    if (raw?.startsWith(`${packageName}/`)) {
      return raw.split(/\s/)[0];
    }
  }

  return undefined;
}

function cmpToAppiumAppActivity(packageName: string, cmp: string): string {
  const slashIdx = cmp.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`Malformed adb activity component "${cmp}"`);
  }

  const pkgFromCmp = cmp.slice(0, slashIdx);
  const clsRawFull = cmp.slice(slashIdx + 1).trim();
  const clsRaw = clsRawFull.split(/\s/)[0];

  if (!clsRaw?.length) {
    throw new Error(`Malformed adb activity component "${cmp}"`);
  }

  if (pkgFromCmp !== packageName) {
    if (clsRaw.startsWith(`${pkgFromCmp}.`) && pkgFromCmp.length > 0) {
      return `.${clsRaw.slice(pkgFromCmp.length)}`;
    }
    return clsRaw;
  }

  if (clsRaw.startsWith('.')) {
    return clsRaw;
  }

  if (!clsRaw.includes('.')) {
    return `.${clsRaw}`;
  }

  if (clsRaw.startsWith(`${packageName}.`)) {
    return `.${clsRaw.slice(packageName.length + 1)}`;
  }

  return clsRaw;
}

export async function resolveAndroidLauncherAppActivity(packageName: string): Promise<string> {
  try {
    execFileSync('adb', ['devices'], { encoding: 'utf8', timeout: 5_000 });
  } catch {
    throw new Error('adb failed. Install Android SDK platform-tools and ensure adb is on PATH.');
  }

  let pkgInstalledLine = '';
  try {
    pkgInstalledLine = execFileSync('adb', ['shell', 'pm', 'path', packageName], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
  } catch {
    pkgInstalledLine = '';
  }

  if (!pkgInstalledLine.startsWith('package:')) {
    throw new Error(
      `Package ${packageName} is not installed on the emulator or device.\nInstall Pepper once from Play Store, then re-run.`,
    );
  }

  const intentString = `#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${packageName};end`;

  let cmp: string | undefined;

  cmp = tryResolveViaPackageCmd(['resolve-activity', '--brief', intentString], packageName);
  cmp ||= tryResolveViaPackageCmd(
    [
      'resolve-activity',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-p',
      packageName,
    ],
    packageName,
  );
  cmp ||= tryResolveViaPackageCmd(
    [
      'resolve-activity',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      packageName,
    ],
    packageName,
  );
  cmp ||= tryResolveViaPackageCmd(['resolve-activity', '--brief', packageName], packageName);

  cmp ||= tryResolveViaPackageCmd(
    [
      'query-activities',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      packageName,
    ],
    packageName,
  );
  cmp ||= tryResolveViaPackageCmd(
    [
      'query-activities',
      '--brief',
      '-p',
      packageName,
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
    ],
    packageName,
  );

  cmp ||= cmpFromDumpFallback(packageName);
  cmp ||= await cmpFromMonkeyAndTopActivity(packageName);

  if (!cmp) {
    throw new Error(
      `Could not resolve launcher activity for ${packageName}.\nTry: adb shell cmd package resolve-activity --brief intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${packageName};end`,
    );
  }

  return cmpToAppiumAppActivity(packageName, cmp);
}
