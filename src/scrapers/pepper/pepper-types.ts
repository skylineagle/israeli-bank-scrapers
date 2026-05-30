import { type TransactionsAccount } from '../../transactions';

export type PepperAccountTotals = Pick<TransactionsAccount, 'savings' | 'investments' | 'foreignCurrency'>;

export type PepperCredentials = {
  phoneNumber: string;
  password: string;
  otpCodeRetriever?: () => Promise<string>;
};

/** Diagnostic snapshot of the dashboard, used to discover which balance-reading path works. */
export type PepperDashboardProbeResult = {
  homeMarkers: {
    name: string;
    exists: boolean;
    displayed: boolean;
    accessibleTextPreview: string;
  }[];
  shekelMatchingNodeCount: number;
  topShekelSamples: { y: number; accessibleText: string }[];
  balanceAttempts: { path: string; value?: number; error?: string }[];
  foreignPivotScanCount?: number;
  foreignBroadScanCount?: number;
  foreignBroadScanPreview?: string[];
};

export type SymbolCurrency = { currency: string; symbolPattern: string };
