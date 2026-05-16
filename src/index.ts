export { CompanyTypes, SCRAPERS } from './definitions';
export { default as createScraper } from './scrapers/factory';

// Note: the typo ScaperScrapingResult & ScraperLoginResult (sic) are exported here for backward compatibility
export {
  ScraperLoginResult as ScaperLoginResult,
  ScraperScrapingResult as ScaperScrapingResult,
  Scraper,
  ScraperCredentials,
  ScraperLoginResult,
  ScraperOptions,
  ScraperScrapingResult,
} from './scrapers/interface';

export { default as OneZeroScraper } from './scrapers/one-zero';
export { default as PepperScraper } from './scrapers/pepper/pepper';
export type { PepperCredentials, PepperDashboardProbeResult } from './scrapers/pepper/pepper';
export {
  extractForeignCurrencyAmountsFromText,
  firstIlsAmountFromCompoundText,
  normalizePepperAccountNumber,
  parseCurrencyAmountSnippet,
} from './scrapers/pepper/pepper';

export function getPuppeteerConfig() {
  return { chromiumRevision: '1250580' }; // https://github.com/puppeteer/puppeteer/releases/tag/puppeteer-core-v22.5.0
}
