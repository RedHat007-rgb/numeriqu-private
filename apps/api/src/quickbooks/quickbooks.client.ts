import quickbooksModule from 'node-quickbooks';
import type { QuickBooks as QuickBooksClass } from 'node-quickbooks';

interface QuickBooksConstructorType {
  new (
    consumerKey: string,
    consumerSecret: string,
    oauthToken: string,
    oauthTokenSecret: string | false,
    realmId: string,
    useSandbox: boolean,
    debug?: boolean,
    minorversion?: string | null,
    oauthversion?: string,
    refreshToken?: string | null,
  ): QuickBooksClass;
}

const quickbooksFactory =
  (
    quickbooksModule as QuickBooksConstructorType & {
      default?: QuickBooksConstructorType;
    }
  ).default ?? quickbooksModule;

export interface QuickBooksOptions {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  realmId: string;
  useSandbox: boolean;
  refreshToken?: string | null;
  debug?: boolean;
  minorVersion?: string | null;
  oauthVersion?: string;
}

const DEFAULT_OAUTH_VERSION = '2.0';

export function createQuickBooksClient(
  options: QuickBooksOptions,
): QuickBooksClass {
  return new quickbooksFactory(
    options.consumerKey,
    options.consumerSecret,
    options.accessToken,
    false,
    options.realmId,
    options.useSandbox,
    options.debug ?? false,
    options.minorVersion ?? null,
    options.oauthVersion ?? DEFAULT_OAUTH_VERSION,
    options.refreshToken ?? null,
  );
}

export type QuickBooksClient = QuickBooksClass;
