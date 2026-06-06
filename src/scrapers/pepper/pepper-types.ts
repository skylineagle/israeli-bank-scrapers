import { type TransactionsAccount } from '../../transactions';

export type PepperAccountTotals = Pick<TransactionsAccount, 'savings' | 'investments' | 'foreignCurrency'>;

export type PepperCredentials = {
  phoneNumber: string;
  password: string;
  otpCodeRetriever?: () => Promise<string>;
};

export type SymbolCurrency = { currency: string; symbolPattern: string };
