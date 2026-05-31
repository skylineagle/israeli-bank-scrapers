import * as readline from 'readline';
import { SCRAPERS } from '../../definitions';
import { maybeTestCompanyAPI, extendAsyncTimeout, getTestsConfig, exportTransactions } from '../../tests/tests-utils';
import { LoginResults } from '../base-scraper-with-browser';
import PepperScraper from './pepper';

const COMPANY_ID = 'pepper';
const testsConfig = getTestsConfig();
const PEPPER_TEST_TIMEOUT_MS = 600_000;

extendAsyncTimeout(PEPPER_TEST_TIMEOUT_MS);

const readStdin = (prompt: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

const pepperOtpCodeRetriever = async (): Promise<string> => {
  const fromEnv = process.env.PEPPER_OTP?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return readStdin('\nOTP: ');
};

const pepperScraperOptions = () => ({
  ...testsConfig.options,
  companyId: COMPANY_ID,
  ...(process.env.PEPPER_AVD ? { avdName: process.env.PEPPER_AVD } : {}),
});

describe('Pepper scraper', () => {
  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.pepper).toBeDefined();
    expect(SCRAPERS.pepper.loginFields).toContain('phoneNumber');
    expect(SCRAPERS.pepper.loginFields).toContain('password');
    expect(SCRAPERS.pepper.loginFields).toContain('otpCodeRetriever');
  });

  maybeTestCompanyAPI(COMPANY_ID, config => config.companyAPI.invalidPassword)(
    'should fail on invalid user/password"',
    async () => {
      const scraper = new PepperScraper(pepperScraperOptions());

      const result = await scraper.scrape({ phoneNumber: '0500000000', password: '3f3ss3d' });

      expect(result).toBeDefined();
      expect(result.success).toBeFalsy();
      expect(result.errorType).toBe(LoginResults.InvalidPassword);
    },
    PEPPER_TEST_TIMEOUT_MS,
  );

  maybeTestCompanyAPI(COMPANY_ID)(
    'should scrape"',
    async () => {
      const scraper = new PepperScraper(pepperScraperOptions());
      const result = await scraper.scrape({
        ...testsConfig.credentials.pepper,
        otpCodeRetriever: pepperOtpCodeRetriever,
      });
      expect(result).toBeDefined();
      const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
      expect(error).toBe('');
      expect(result.success).toBeTruthy();

      exportTransactions(COMPANY_ID, result.accounts || []);
    },
    PEPPER_TEST_TIMEOUT_MS,
  );
});
