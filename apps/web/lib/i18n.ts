/**
 * English and Arabic text. Arabic is written for Gulf business users in Modern Standard Arabic and should be
 * reviewed by a native-speaking business reader before the pilot.
 */
export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const isLocale = (v: string): v is Locale => (LOCALES as readonly string[]).includes(v);
export const dirOf = (l: Locale) => (l === 'ar' ? 'rtl' : 'ltr');

const en = {
  brand: { tagline: 'One Platform. Every Conversation. Every Customer.', by: 'by Meronatic' },
  lang: { switchTo: 'العربية', switchLabel: 'Switch to Arabic' },
  features: {
    secure: 'Secure and reliable',
    gulf: 'Built for the Gulf and beyond',
    ai: 'Ready for AI automation',
    separate: 'Each company fully separated',
  },
  signIn: {
    title: 'Sign in to ConversaFlow',
    subtitle: 'Your customer conversations, team and automations in one place.',
    email: 'Email address',
    password: 'Password',
    forgot: 'Forgot password?',
    submit: 'Sign in',
    noAccount: "Don't have an account?",
    create: 'Create one',
    mfaTitle: 'Two-step verification',
    mfaHelp: 'Enter the 6-digit code from your authenticator app.',
    code: 'Verification code',
    verify: 'Verify',
    invalid: 'Email or password is incorrect.',
    badCode: 'That code is not correct. Please try again.',
    unverified: 'Please verify your email address first.',
    tooMany: 'Too many attempts. Please wait a few minutes and try again.',
  },
  signUp: {
    title: 'Create your account',
    subtitle: 'Start a 14-day trial. No card needed.',
    fullName: 'Full name',
    submit: 'Create account',
    sent: 'Check your email for a link to verify your address.',
    have: 'Already have an account?',
    signIn: 'Sign in',
    passwordHint: 'At least 12 characters.',
    checkFields: 'Please check the details. Passwords need at least 12 characters and cannot be a common password.',
  },
  forgot: { title: 'Reset your password', submit: 'Send reset link', sent: 'If an account exists for this email, we have sent a link to reset the password.' },
  notFound: { title: 'Page not found', body: 'The page you are looking for does not exist or has moved.', home: 'Go to sign-in' },
  verify: { title: 'Verifying your email', done: 'Your email is verified. You can sign in now.', failed: 'This link is invalid or has expired. Please sign up again or request a new link.' },
  reset: { title: 'Choose a new password', newPassword: 'New password', submit: 'Save new password', done: 'Your password has been changed. Please sign in.', failed: 'This link is invalid or has expired. Please request a new one.' },
  common: { error: 'Something went wrong. Please try again.', loading: 'Loading…', save: 'Save changes', saved: 'Changes saved', signOut: 'Sign out', later: 'Coming in a later phase' },
  nav: {
    dashboard: 'Dashboard', inbox: 'Inbox', contacts: 'Contacts', campaigns: 'Campaigns', automations: 'Automations',
    reports: 'Reports', settings: 'Settings', company: 'Company', team: 'Team and roles', menu: 'Menu', main: 'Main navigation',
  },
  dashboard: {
    welcome: 'Welcome, {name}',
    plan: 'Plan',
    trial: 'Trial ends on {date}',
    seats: 'Seats used',
    runs: 'Automation runs this month',
    next: 'Next steps',
    step1: 'Invite your team',
    step2: 'Set your business hours',
    step3: 'Connect WhatsApp (Phase 2)',
  },
  company: {
    title: 'Company settings',
    hours: 'Business hours',
    closed: 'Closed',
    open: 'Opens',
    close: 'Closes',
    languages: 'Languages your customers use',
    sla: 'Response targets',
    first: 'First reply within (minutes)',
    resolve: 'Resolve within (minutes)',
    holidays: 'Public holidays',
    noHolidays: 'No holidays added yet.',
  },
  team: { title: 'Team and roles', name: 'Name', email: 'Email', role: 'Role', status: 'Status', active: 'Active' },
  roles: { owner: 'Owner', admin: 'Admin', supervisor: 'Supervisor', agent: 'Agent', analyst: 'Analyst' } as Record<string, string>,
  days: { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' } as Record<string, string>,
  languageNames: { en: 'English', ar: 'Arabic' } as Record<string, string>,
};

const ar: typeof en = {
  brand: { tagline: 'منصة واحدة. كل محادثة. كل عميل.', by: 'by Meronatic' }, // brand lockup stays in Latin
  lang: { switchTo: 'English', switchLabel: 'التبديل إلى الإنجليزية' },
  features: {
    secure: 'آمنة وموثوقة',
    gulf: 'مصممة للخليج والعالم',
    ai: 'جاهزة لأتمتة الذكاء الاصطناعي',
    separate: 'فصل تام لبيانات كل شركة',
  },
  signIn: {
    title: 'تسجيل الدخول إلى ConversaFlow',
    subtitle: 'محادثات عملائك وفريقك وعمليات الأتمتة في مكان واحد.',
    email: 'البريد الإلكتروني',
    password: 'كلمة المرور',
    forgot: 'نسيت كلمة المرور؟',
    submit: 'تسجيل الدخول',
    noAccount: 'ليس لديك حساب؟',
    create: 'أنشئ حسابًا',
    mfaTitle: 'التحقق بخطوتين',
    mfaHelp: 'أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة.',
    code: 'رمز التحقق',
    verify: 'تحقّق',
    invalid: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    badCode: 'الرمز غير صحيح. يُرجى المحاولة مرة أخرى.',
    unverified: 'يُرجى تأكيد بريدك الإلكتروني أولًا.',
    tooMany: 'محاولات كثيرة. يُرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى.',
  },
  signUp: {
    title: 'إنشاء حسابك',
    subtitle: 'ابدأ تجربة مجانية لمدة 14 يومًا دون الحاجة إلى بطاقة.',
    fullName: 'الاسم الكامل',
    submit: 'إنشاء الحساب',
    sent: 'تحقّق من بريدك الإلكتروني للعثور على رابط تأكيد العنوان.',
    have: 'لديك حساب بالفعل؟',
    signIn: 'سجّل الدخول',
    passwordHint: '12 حرفًا على الأقل.',
    checkFields: 'يُرجى مراجعة البيانات. يجب ألا تقل كلمة المرور عن 12 حرفًا وألا تكون كلمة مرور شائعة.',
  },
  forgot: { title: 'إعادة تعيين كلمة المرور', submit: 'إرسال رابط إعادة التعيين', sent: 'إذا كان هناك حساب مرتبط بهذا البريد، فقد أرسلنا رابطًا لإعادة تعيين كلمة المرور.' },
  notFound: { title: 'الصفحة غير موجودة', body: 'الصفحة التي تبحث عنها غير موجودة أو تم نقلها.', home: 'الانتقال إلى تسجيل الدخول' },
  verify: { title: 'جارٍ تأكيد بريدك الإلكتروني', done: 'تم تأكيد بريدك الإلكتروني. يمكنك تسجيل الدخول الآن.', failed: 'هذا الرابط غير صالح أو منتهي الصلاحية. يُرجى التسجيل مجددًا أو طلب رابط جديد.' },
  reset: { title: 'اختر كلمة مرور جديدة', newPassword: 'كلمة المرور الجديدة', submit: 'حفظ كلمة المرور الجديدة', done: 'تم تغيير كلمة المرور. يُرجى تسجيل الدخول.', failed: 'هذا الرابط غير صالح أو منتهي الصلاحية. يُرجى طلب رابط جديد.' },
  common: { error: 'حدث خطأ ما. يُرجى المحاولة مرة أخرى.', loading: 'جارٍ التحميل…', save: 'حفظ التغييرات', saved: 'تم حفظ التغييرات', signOut: 'تسجيل الخروج', later: 'متاح في مرحلة لاحقة' },
  nav: {
    dashboard: 'لوحة التحكم', inbox: 'صندوق الوارد', contacts: 'جهات الاتصال', campaigns: 'الحملات', automations: 'الأتمتة',
    reports: 'التقارير', settings: 'الإعدادات', company: 'الشركة', team: 'الفريق والأدوار', menu: 'القائمة', main: 'التنقل الرئيسي',
  },
  dashboard: {
    welcome: 'مرحبًا، {name}',
    plan: 'الباقة',
    trial: 'تنتهي الفترة التجريبية في {date}',
    seats: 'المقاعد المستخدمة',
    runs: 'عمليات الأتمتة هذا الشهر',
    next: 'الخطوات التالية',
    step1: 'ادعُ فريقك',
    step2: 'حدّد ساعات العمل',
    step3: 'اربط واتساب (المرحلة الثانية)',
  },
  company: {
    title: 'إعدادات الشركة',
    hours: 'ساعات العمل',
    closed: 'مغلق',
    open: 'يفتح',
    close: 'يغلق',
    languages: 'اللغات التي يستخدمها عملاؤك',
    sla: 'أهداف الاستجابة',
    first: 'أول رد خلال (بالدقائق)',
    resolve: 'الحل خلال (بالدقائق)',
    holidays: 'العطلات الرسمية',
    noHolidays: 'لم تُضف أي عطلات بعد.',
  },
  team: { title: 'الفريق والأدوار', name: 'الاسم', email: 'البريد الإلكتروني', role: 'الدور', status: 'الحالة', active: 'نشط' },
  roles: { owner: 'المالك', admin: 'مسؤول', supervisor: 'مشرف', agent: 'موظف خدمة العملاء', analyst: 'محلل' },
  days: { sun: 'الأحد', mon: 'الاثنين', tue: 'الثلاثاء', wed: 'الأربعاء', thu: 'الخميس', fri: 'الجمعة', sat: 'السبت' },
  languageNames: { en: 'الإنجليزية', ar: 'العربية' },
};

export const dictionaries = { en, ar };
export type Dictionary = typeof en;
export const t = (l: Locale): Dictionary => dictionaries[l];
export const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

/** Gulf business convention in software: Western digits in both languages, Gregorian calendar. */
export const formatDate = (l: Locale, iso: string) =>
  new Intl.DateTimeFormat(l === 'ar' ? 'ar-AE-u-nu-latn-ca-gregory' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
export const formatNumber = (l: Locale, n: number) => new Intl.NumberFormat(l === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB').format(n);
