import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

export const defaultNS = 'translation';

export const resources = {
  ar: {
    translation: {
      app: {
        title: 'نظام الخزينة والمحاسبة',
        subtitle: 'إدارة متكاملة غير متصلة بالإنترنت',
      },
      nav: {
        dashboard: 'لوحة التحكم',
        sales: 'المبيعات',
        purchases: 'المشتريات',
        inventory: 'المخزون',
        treasury: 'الخزينة والبنوك',
        accounting: 'المحاسبة العامة',
        pos: 'نقطة البيع (POS)',
        parties: 'العملاء والموردين',
        hr: 'الموارد البشرية',
        fixed_assets: 'الأصول الثابتة',
        budgets: 'الموازنات',
        reports: 'التقارير',
        settings: 'الإعدادات',
        audit: 'سجل التدقيق',
        backup: 'النسخ الاحتياطي',
        more: 'المزيد',
      },
      sync: {
        synced: 'متصل ومتزامن',
        syncing: 'جارِ المزامنة...',
        offline: 'غير متصل (يعمل محلياً)',
        pending_count: '{{count}} معلق',
        conflicts: '{{count}} تعارض',
        last_synced: 'آخر مزامنة: {{time}}',
      },
      branch: {
        switch: 'تبديل الفرع',
        all: 'كافة الفروع',
        main: 'الفرع الرئيسي',
        current: 'الفرع الحالي',
      },
      auth: {
        login: 'تسجيل الدخول',
        logout: 'تسجيل الخروج',
        email: 'البريد الإلكتروني',
        password: 'كلمة المرور',
        remember_me: 'تذكر هذا الجهاز محلياً',
        role: 'الدور الوظيفي',
        device_pin: 'رمز المرور السريع (PIN)',
        offline_ready: 'جلسة العمل مفعلة للعمل دون إنترنت',
      },
      common: {
        save: 'حفظ',
        cancel: 'إلغاء',
        delete: 'حذف',
        edit: 'تعديل',
        add: 'إضافة',
        create: 'إنشاء جديد',
        search: 'بحث...',
        filter: 'تصفية',
        export: 'تصدير',
        import: 'استيراد',
        print: 'طباعة',
        status: 'الحالة',
        actions: 'إجراءات',
        total: 'الإجمالي',
        subtotal: 'المجموع الفرعي',
        tax: 'ضريبة القيمة المضافة',
        discount: 'الخصم',
        date: 'التاريخ',
        notes: 'ملاحظات',
        loading: 'جارِ التحميل...',
        no_data: 'لا توجد بيانات مسجلة بعد',
      },
      ios: {
        install_title: 'تثبيت التطبيق على جهازك',
        install_desc: 'لتجربة سلسة وتفادي حذف البيانات من النظام، يرجى إضافة التطبيق للشاشة الرئيسية:',
        step1: 'اضغط على زر المشاركة (Share) في أسفل متصفح Safari',
        step2: 'مرر لأسفل واختر "إضافة إلى الشاشة الرئيسية" (Add to Home Screen)',
        step3: 'اضغط على "إضافة" (Add) في الزاوية العلوية',
        dismiss: 'فهمت ذلك',
      },
    },
  },
  en: {
    translation: {
      app: {
        title: 'Treasury & Accounting ERP',
        subtitle: 'Offline-First Management System',
      },
      nav: {
        dashboard: 'Dashboard',
        sales: 'Sales',
        purchases: 'Purchases',
        inventory: 'Inventory',
        treasury: 'Treasury & Banks',
        accounting: 'General Accounting',
        pos: 'POS Terminal',
        parties: 'Customers & Suppliers',
        hr: 'HR & Payroll',
        fixed_assets: 'Fixed Assets',
        budgets: 'Budgets',
        reports: 'Reports',
        settings: 'Settings',
        audit: 'Audit Log',
        backup: 'Backup & Restore',
        more: 'More',
      },
      sync: {
        synced: 'Online & Synced',
        syncing: 'Syncing...',
        offline: 'Offline (Local mode)',
        pending_count: '{{count}} pending',
        conflicts: '{{count}} conflicts',
        last_synced: 'Last synced: {{time}}',
      },
      branch: {
        switch: 'Switch Branch',
        all: 'All Branches',
        main: 'Main Branch',
        current: 'Current Branch',
      },
      auth: {
        login: 'Login',
        logout: 'Logout',
        email: 'Email',
        password: 'Password',
        remember_me: 'Remember this device locally',
        role: 'Role',
        device_pin: 'Quick PIN',
        offline_ready: 'Offline cached session active',
      },
      common: {
        save: 'Save',
        cancel: 'Cancel',
        delete: 'Delete',
        edit: 'Edit',
        add: 'Add',
        create: 'Create New',
        search: 'Search...',
        filter: 'Filter',
        export: 'Export',
        import: 'Import',
        print: 'Print',
        status: 'Status',
        actions: 'Actions',
        total: 'Total',
        subtotal: 'Subtotal',
        tax: 'VAT',
        discount: 'Discount',
        date: 'Date',
        notes: 'Notes',
        loading: 'Loading...',
        no_data: 'No data recorded yet',
      },
      ios: {
        install_title: 'Install App on Your iPhone',
        install_desc: 'To prevent browser data eviction and ensure reliable offline use:',
        step1: 'Tap the Share icon in Safari bottom bar',
        step2: 'Scroll down and select "Add to Home Screen"',
        step3: 'Tap "Add" in the top right corner',
        dismiss: 'Got it',
      },
    },
  },
} as const;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'ar',
    lng: 'ar', // Default Arabic
    interpolation: {
      escapeValue: false,
    },
  });

// Set document direction based on language
document.documentElement.dir = i18n.language === 'en' ? 'ltr' : 'rtl';
document.documentElement.lang = i18n.language;

i18n.on('languageChanged', (lng) => {
  document.documentElement.dir = lng === 'en' ? 'ltr' : 'rtl';
  document.documentElement.lang = lng;
});

export default i18n;
