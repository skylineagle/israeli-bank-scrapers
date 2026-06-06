export const PEPPER_PACKAGE_NAME = 'com.pepper.ldb';

export const ISRAELI_PHONE_COUNTRY_CODE = '+972';

/** Build an Appium UiAutomator2 selector string from a UiSelector expression. */
export const uiSelector = (selectorExpression: string): string => `android=new UiSelector().${selectorExpression}`;

const resourceIdSelectors = {
  phoneInput: `//android.widget.EditText[@resource-id="${PEPPER_PACKAGE_NAME}:id/etPhoneNumber"]`,
  otpInput: `//android.widget.EditText[@resource-id="${PEPPER_PACKAGE_NAME}:id/etOtp"]`,
  continueButton: `//android.widget.Button[@resource-id="${PEPPER_PACKAGE_NAME}:id/btnContinue"]`,
  verifyOtpButton: `//android.widget.Button[@resource-id="${PEPPER_PACKAGE_NAME}:id/btnVerify"]`,
  transactionsTab: `//android.widget.TextView[@resource-id="${PEPPER_PACKAGE_NAME}:id/tvTransactions"]`,
} as const;

export const PEPPER_BOTTOM_NAV_HOME_SELECTORS: readonly string[] = [
  '//android.view.View[@content-desc="בית"][@clickable="true"]',
  '//*[@content-desc="בית"][@clickable="true"]',
];

export const PEPPER_HOME_TAB_SELECTORS: readonly string[] = [
  ...PEPPER_BOTTOM_NAV_HOME_SELECTORS,
  '//android.widget.TextView[@text="בית"]',
  '//*[@text="בית" and (@clickable="true" or @focusable="true")]',
  uiSelector('textContains("בית").clickable(true)'),
  uiSelector('descriptionContains("בית")'),
];

export const PEPPER_HOME_DASHBOARD_READY_SELECTORS: readonly string[] = [
  '//android.widget.Button[contains(@text,"זאת היתרה")]',
  '//*[@clickable="true"][contains(@text,"זאת היתרה")]',
  uiSelector('textContains("זאת היתרה").clickable(true)'),
  '//*[contains(@text,"חסכונות")]',
  '//*[contains(@content-desc,"חסכונות")]',
  uiSelector('textContains("חסכונות")'),
  uiSelector('descriptionContains("חסכונות")'),
];

export const PEPPER_PROFILE_SCREEN_SELECTORS: readonly string[] = [
  uiSelector('textContains("פרטי חשבון")'),
  uiSelector('textContains("פרופיל")'),
  uiSelector('descriptionContains("פרופיל")'),
  uiSelector('textContains("העתק")'),
  uiSelector('descriptionContains("העתק")'),
  '//*[contains(@text,"העתקת") or contains(@content-desc,"העתקת")]',
  '//*[contains(@text,"מספר חשבון") or contains(@content-desc,"מספר חשבון")]',
];

export const PEPPER_LOGGED_IN_SELECTORS: readonly string[] = [
  ...PEPPER_HOME_DASHBOARD_READY_SELECTORS,
  ...PEPPER_BOTTOM_NAV_HOME_SELECTORS,
  uiSelector('textContains("זאת היתרה")'),
  uiSelector('textContains("יתרה שלך")'),
  '//android.widget.TextView[contains(@text,"יתרה שלך")]',
  '//*[contains(@text,"תנועות אחרונות")]',
  uiSelector('textContains("תנועות אחרונות")'),
  '//*[contains(@text,"העברת כסף")]',
  uiSelector('textContains("העברת כסף")'),
  uiSelector(`resourceIdMatches("${PEPPER_PACKAGE_NAME}:id/.*[Bb]alance.*").className("android.widget.TextView")`),
  `//*[contains(@resource-id,'${PEPPER_PACKAGE_NAME}:id/')][contains(@resource-id,'Balance')]`,
  '//*[@text="פעולות"]',
  uiSelector('textContains("פעולות").clickable(true)'),
  resourceIdSelectors.transactionsTab,
  uiSelector(`resourceId("${PEPPER_PACKAGE_NAME}:id/tvTransactions")`),
  uiSelector('descriptionContains("יתרה")'),
];

export const PEPPER_BALANCE_SELECTORS: readonly string[] = [
  "//*[contains(@resource-id,'Balance')]",
  uiSelector('resourceIdMatches("(?i).*balance.*").className("android.widget.TextView")'),
  uiSelector(`resourceIdMatches("${PEPPER_PACKAGE_NAME}:id/.*[Bb]alance.*").className("android.widget.TextView")`),
  "//*[contains(@text,'₪') or contains(@text,'\u20aa') or contains(@content-desc,'₪') or contains(@content-desc,'\u20aa')]",
  uiSelector('descriptionContains("יתרה")'),
  uiSelector('textContains("יתרה")'),
  '//android.widget.Button[contains(@text,"זאת היתרה")]',
  '//*[@clickable="true"][contains(@text,"זאת היתרה")]',
];

export const PEPPER_PHONE_SELECTORS_STRICT: readonly string[] = [
  resourceIdSelectors.phoneInput,
  uiSelector(`resourceId("${PEPPER_PACKAGE_NAME}:id/etPhoneNumber")`),
  '//android.widget.EditText[@content-desc="מספר טלפון"]',
  "//android.widget.EditText[contains(@content-desc,'טלפון')]",
  uiSelector('descriptionContains("מספר טלפון")'),
  uiSelector('descriptionContains("טלפון")'),
  "//android.widget.EditText[contains(@resource-id,'etPhoneNumber')]",
  "//android.widget.EditText[contains(@resource-id,'phone')]",
  "//android.widget.EditText[contains(@resource-id,'Phone')]",
  "//android.widget.EditText[contains(@resource-id,'mobile')]",
  "//android.widget.EditText[contains(@resource-id,'Mobile')]",
  "//android.widget.EditText[contains(@resource-id,'tel')]",
  uiSelector('resourceIdMatches("(?i).*phone.*").className("android.widget.EditText")'),
];

export const PEPPER_PHONE_SELECTORS: readonly string[] = [
  ...PEPPER_PHONE_SELECTORS_STRICT,
  uiSelector('descriptionContains("טלפון")'),
  uiSelector('descriptionContains("נייד")'),
];

/** First-launch marketing screen — tap to reach the phone/password login form. */
export const PEPPER_WELCOME_CONTINUE_SELECTORS: readonly string[] = [
  '//*[@text="כניסה לחשבון שלי"]',
  '//*[contains(@text,"כניסה לחשבון שלי")]',
  '//android.widget.Button[@text="כניסה לחשבון שלי"]',
  '//android.widget.Button[contains(@text,"כניסה לחשבון שלי")]',
  '//*[@content-desc="כניסה לחשבון שלי"]',
  '//*[contains(@content-desc,"כניסה לחשבון שלי")]',
  uiSelector('text("כניסה לחשבון שלי")'),
  uiSelector('descriptionContains("כניסה לחשבון שלי")'),
  uiSelector('textContains("לחשבון שלי")'),
  uiSelector('text("כניסה")'),
  uiSelector('textContains("יש לי חשבון")'),
  uiSelector('textContains("בואו נתחיל")'),
  uiSelector('textContains("להמשיך")'),
  uiSelector('textMatches("(?i).*start.*")'),
  uiSelector('resourceIdMatches("(?i).*welcome.*").clickable(true)'),
  "//android.widget.Button[contains(@resource-id,'continue')]",
  "//android.widget.Button[contains(@resource-id,'start')]",
];

export const PEPPER_CONTINUE_SELECTORS: readonly string[] = [
  resourceIdSelectors.continueButton,
  uiSelector('classNameContains("FloatingActionButton").clickable(true)'),
  uiSelector('resourceIdMatches("(?i).*fab.*").clickable(true)'),
  uiSelector('resourceIdMatches("(?i).*next.*").clickable(true)'),
  uiSelector('resourceIdMatches("(?i).*submit.*").clickable(true)'),
  uiSelector('descriptionMatches("(?i).*next.*")'),
  uiSelector('descriptionMatches("(?i).*arrow.*")'),
  uiSelector('descriptionContains("הבא")'),
  uiSelector('descriptionContains("המשך")'),
  uiSelector('resourceIdMatches("(?i).*continue.*").clickable(true)'),
  uiSelector('textMatches("(?i).*continue.*")'),
  '//android.widget.Button[@text="המשך"]',
  '//*[@text="המשך"]',
  uiSelector('textContains("המשך")'),
  uiSelector('textContains("הבא")'),
];

export const PEPPER_POST_CREDENTIALS_SUBMIT_SELECTORS: readonly string[] = [
  '//*[@text="כניסה לחשבון"]',
  "//android.widget.Button[contains(@text,'כניסה לחשבון')]",
  uiSelector('textContains("כניסה לחשבון")'),
  uiSelector('descriptionContains("כניסה לחשבון")'),
  resourceIdSelectors.continueButton,
  uiSelector('resourceIdMatches("(?i).*login.*").clickable(true)'),
  uiSelector('resourceIdMatches("(?i).*signin.*").clickable(true)'),
  uiSelector('resourceIdMatches("(?i).*sign_in.*").clickable(true)'),
  uiSelector('classNameContains("FloatingActionButton").clickable(true)'),
  uiSelector('resourceIdMatches("(?i).*fab.*").clickable(true)'),
  uiSelector('resourceIdMatches("(?i).*submit.*").clickable(true)'),
];

export const PEPPER_PASSWORD_SELECTORS: readonly string[] = [
  uiSelector(`resourceId("${PEPPER_PACKAGE_NAME}:id/etPassword")`),
  uiSelector('descriptionContains("סיסמה")'),
  "//android.widget.EditText[contains(@hint,'סיסמה')]",
  "//android.widget.EditText[contains(@resource-id,'password')]",
  "//android.widget.EditText[contains(@resource-id,'Password')]",
  uiSelector('resourceIdMatches("(?i).*password.*").className("android.widget.EditText")'),
  '//android.widget.EditText[@password="true"]',
];

export const PEPPER_INVALID_CREDENTIALS_MESSAGE_SELECTORS: readonly string[] = [
  uiSelector('textContains("אחד או יותר מהפרטים לא נכונים")'),
  uiSelector('descriptionContains("אחד או יותר מהפרטים לא נכונים")'),
  '//*[contains(@text,"אחד או יותר מהפרטים לא נכונים")]',
  '//*[contains(@content-desc,"אחד או יותר מהפרטים לא נכונים")]',
];

export const PEPPER_INVALID_CREDENTIALS_BACK_SELECTORS: readonly string[] = [
  '//*[@text="חזרה להתחברות"]',
  "//android.widget.Button[contains(@text,'חזרה להתחברות')]",
  uiSelector('text("חזרה להתחברות")'),
  uiSelector('textContains("חזרה להתחברות")'),
  uiSelector('descriptionContains("חזרה להתחברות")'),
];

export const PEPPER_INVALID_CREDENTIALS_SCREEN_SELECTORS: readonly string[] = [
  ...PEPPER_INVALID_CREDENTIALS_MESSAGE_SELECTORS,
  ...PEPPER_INVALID_CREDENTIALS_BACK_SELECTORS,
];

/**
 * Pepper has shipped at least two OTP screen variants:
 *   (a) Custom React Native widget with 6 ViewGroup boxes (resource-id="otp-input") + custom keyboard.
 *   (b) Standard single EditText with 6 underline positions + system soft keyboard.
 * Both are detected here; entry is handled by PepperScraper.enterOtpCode().
 */
/** Fast-path selectors polled after password entry (Pepper auto-advances to OTP). */
export const PEPPER_OTP_WAIT_SELECTORS: readonly string[] = [
  '//*[@resource-id="otp-input"]',
  '//*[@resource-id="accessible-rect-button"]',
  '//*[@resource-id="otpScreen.phoneMessage"]',
];

export const PEPPER_OTP_INPUT_SELECTORS: readonly string[] = [
  '//*[@resource-id="otp-input"]',
  '//*[@resource-id="accessible-rect-button"]',
  '//*[@resource-id="otpScreen.phoneMessage"]',
  resourceIdSelectors.otpInput,
  "//android.widget.EditText[contains(@resource-id,'otp')]",
  "//android.widget.EditText[contains(@resource-id,'Otp')]",
  uiSelector('resourceIdMatches("(?i).*otp.*").className("android.widget.EditText")'),
];

export const PEPPER_OTP_FOCUS_SELECTORS: readonly string[] = [
  '//*[@resource-id="accessible-rect-button"]',
  '//*[@resource-id="otp-input"]',
  "//android.widget.EditText[contains(@resource-id,'otp')]",
  "//android.widget.EditText[contains(@resource-id,'Otp')]",
  '//android.widget.EditText',
];

export const PEPPER_OTP_SCREEN_MARKERS: readonly string[] = [
  '//*[@resource-id="otpScreen.phoneMessage"]',
  uiSelector('textContains("שלחנו לך קוד")'),
  uiSelector('textContains("מה הקוד שקיבלת")'),
  uiSelector('textContains("קוד האימות")'),
  uiSelector('descriptionContains("קוד האימות")'),
  uiSelector('textContains("הקוד לא הגיע")'),
  uiSelector('textContains("הודעה קולית")'),
];

/** Google Password Manager / autofill "save password?" sheet after login. */
export const PEPPER_AUTOFILL_DISMISS_SELECTORS: readonly string[] = [
  '//*[@text="Not now"]',
  '//*[@content-desc="Not now"]',
  uiSelector('text("Not now")'),
  uiSelector('textContains("Not now")'),
  uiSelector('descriptionContains("Not now")'),
  '//*[@text="לא עכשיו"]',
  uiSelector('textContains("לא עכשיו")'),
  '//*[@text="Never"]',
  uiSelector('text("Never")'),
  uiSelector('textContains("Never")'),
];

export const PEPPER_NOTIFICATION_POPUP_SELECTORS: readonly string[] = [
  '//android.widget.TextView[@text="רוצה להישאר בעניינים?"]',
  uiSelector('textContains("רוצה להישאר בעניינים?")'),
  '//android.widget.Button[@content-desc="סגירה"]',
];

export const PEPPER_NOTIFICATION_POPUP_DISMISS_SELECTORS: readonly string[] = [
  '//*[@text="בפעם אחרת"]',
  uiSelector('textContains("בפעם אחרת")'),
  '//android.widget.Button[@content-desc="סגירה"]',
  uiSelector('descriptionContains("סגירה").clickable(true)'),
];

export const PEPPER_TERMS_SCREEN_SELECTORS: readonly string[] = [
  '//android.widget.Button[@content-desc="אני מסכימ/ה"]',
  uiSelector('descriptionContains("אני מסכימ/ה").clickable(true)'),
  '//android.widget.CheckBox[@resource-id="pressable"]',
  uiSelector('textContains("תנאי השימוש")'),
  uiSelector('textContains("רגע לפני שמתחילים")'),
];

export const PEPPER_TERMS_CHECKBOX_SELECTORS: readonly string[] = [
  '//android.widget.CheckBox[@resource-id="pressable"]',
  uiSelector('className("android.widget.CheckBox").clickable(true)'),
];

export const PEPPER_TERMS_AGREE_SELECTORS: readonly string[] = [
  '//android.widget.Button[@content-desc="אני מסכימ/ה"]',
  uiSelector('descriptionContains("אני מסכימ/ה").clickable(true)'),
  uiSelector('textContains("אני מסכימ").clickable(true)'),
  '//android.widget.Button[@resource-id="pressable"]',
];

export const PEPPER_VERIFY_SELECTORS: readonly string[] = [
  resourceIdSelectors.verifyOtpButton,
  uiSelector('resourceIdMatches("(?i).*verify.*").clickable(true)'),
  uiSelector('textMatches("(?i).*verify.*")'),
  '//android.widget.Button[@text="אימות"]',
  '//*[@text="אימות"]',
  uiSelector('textContains("אימות")'),
  uiSelector('descriptionContains("אימות")'),
  uiSelector('textContains("אשר")'),
];

export const PEPPER_LOGIN_SUBMIT_TEXT_SELECTORS: readonly string[] = [
  '//*[@text="כניסה לחשבון"]',
  uiSelector('textContains("כניסה לחשבון")'),
];

/** XPath predicate matching any node whose text or content-desc mentions the shekel sign. */
export const PEPPER_SHEKEL_PREDICATE = "contains(@text,'₪') or contains(@content-desc,'₪')";

/** Any node whose text or content-desc mentions the shekel sign. */
export const PEPPER_SHEKEL_NODE_SELECTOR = `//*[${PEPPER_SHEKEL_PREDICATE}]`;

/** Hint that a node likely carries a foreign-currency amount, used to filter the broad dashboard scan. */
export const PEPPER_FOREIGN_CURRENCY_HINT_REGEX =
  /[$€£¥]|מט\u05f4ח|מט["׳']ח|\bUSD\b|\bEUR\b|\bGBP\b|\bCHF\b|\bJPY\b|\bCAD\b|\bAUD\b|\bPLN\b/i;

/** Currency symbols / codes used to query only the nodes that could carry a foreign-currency amount. */
const FOREIGN_CURRENCY_NODE_TERMS = ['$', '€', '£', '¥', 'מט', 'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'PLN'];

/**
 * Targeted selector matching only nodes whose text/content-desc contain a currency marker.
 * Far cheaper than scanning every node, since each match still costs several Appium round-trips.
 */
export const PEPPER_FOREIGN_CURRENCY_NODE_SELECTOR = `//*[${FOREIGN_CURRENCY_NODE_TERMS.map(
  term => `contains(@text,'${term}') or contains(@content-desc,'${term}')`,
).join(' or ')}]`;

/** Matches the line that introduces the account number inside copied profile text. */
export const PEPPER_ACCOUNT_LINE_REGEX = /חשבון[^\n]*/u;

/** Matches a dashed (optionally masked) account-number token inside copied profile text. */
export const PEPPER_DASHED_ACCOUNT_TOKEN_REGEX = /\b\d{1,3}-\d{1,3}-[\d*•-]{3,}\b/u;

/** Characters stripped from a raw balance string before a last-resort numeric parse. */
export const PEPPER_BALANCE_AMOUNT_STRIP_REGEX = /[₪,\s]/g;

/**
 * Hardcoded tap targets on the profile/account screen. These controls expose no text,
 * content-desc, or resource-id, so they cannot be located by selector and must be tapped
 * by coordinate. Reference device resolution: 1280 × 2856.
 * NOTE: these are resolution-specific and must be revisited if the AVD profile changes or pepper changes app layouts.
 */
export const PEPPER_PROFILE_COORDINATES = {
  openProfileFromHome: { x: 575, y: 291 },
  copyAccountNumberControl: { x: 78, y: 739 },
  backButton: { x: 1172, y: 531 },
} as const;
