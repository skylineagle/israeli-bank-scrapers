import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';

const scraper = createScraper({
  companyId: CompanyTypes.pepper,
  startDate: new Date('2026-01-01'),
});

const result = await scraper.scrape({
  phoneNumber: '0501234567',
  otpCodeRetriever: async () => {
    // read the OTP from stdin, SMS gateway, email, etc.
    return await readOtpFromSomewhere();
  },
});