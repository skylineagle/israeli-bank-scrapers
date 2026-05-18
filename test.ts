import * as readline from 'readline';
import { CompanyTypes } from './src/definitions';
import PepperScraper from './src/scrapers/pepper/pepper';

const PHONE = process.env.PEPPER_PHONE ?? '';
const PASSWORD = process.env.PEPPER_PASSWORD ?? '';
const AVD = process.env.PEPPER_AVD;
const START_DATE = process.env.PEPPER_START_DATE
  ? new Date(process.env.PEPPER_START_DATE)
  : new Date(new Date().getFullYear(), 0, 1);

if (!PHONE || !PASSWORD) {
  console.error('Usage: PEPPER_PHONE=0501234567 PEPPER_PASSWORD=secret bun test.ts');
  console.error('       PEPPER_PHONE=... PEPPER_PASSWORD=... PEPPER_PROBE=1 bun test.ts   # UI probe JSON only');
  console.error('       PEPPER_PHONE=0501234567 PEPPER_PASSWORD=secret PEPPER_AVD=Pixel_9_API_35 bun test.ts');
  process.exit(1);
}

const readStdin = (prompt: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

const scraper = new PepperScraper({
  companyId: CompanyTypes.pepper,
  startDate: START_DATE,
  avdName: AVD,
  verbose: process.env.DEBUG === '1',
  shutdownEmulatorOnTerminate: process.env.PEPPER_LEAVE_EMULATOR !== '1',
});

const otpCodeRetriever = () => readStdin('\nOTP: ');

if (process.env.PEPPER_PROBE === '1') {
  console.log('Pepper UI probe (PEPPER_PROBE=1) — JSON report, not the normal scrape summary.');
  console.log(`phone=${PHONE}`);
  if (AVD) console.log(`AVD: ${AVD}`);
  const probe = await scraper.runProbeSession({
    phoneNumber: PHONE,
    password: PASSWORD,
    otpCodeRetriever,
  });
  console.log(JSON.stringify(probe, null, 2));
  process.exit(0);
}

console.log(`Starting Pepper scraper…  phone=${PHONE}  from=${START_DATE.toDateString()}`);
if (AVD) console.log(`AVD: ${AVD}`);

const result = await scraper.scrape({
  phoneNumber: PHONE,
  password: PASSWORD,
  otpCodeRetriever,
});

if (!result.success) {
  console.error('\nScrape failed:', result.errorType, '-', result.errorMessage);
  process.exit(1);
}

for (const account of result.accounts ?? []) {
  console.log(`\nAccount: ${account.accountNumber}  Balance: ₪${account.balance}`);
  console.log(`Info: ${JSON.stringify(account)}`);
  console.log(`Transactions (${account.txns.length}):`);
  for (const tx of account.txns) {
    const sign = tx.chargedAmount >= 0 ? '+' : '';
    console.log(`  ${tx.date.slice(0, 10)}  ${tx.description.padEnd(30)}  ${sign}₪${tx.chargedAmount}`);
  }
}
