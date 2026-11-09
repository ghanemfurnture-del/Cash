import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { DashboardPage } from '../modules/dashboard/DashboardPage';
import { BackupPage } from '../modules/backup/BackupPage';
import { SyncConflictsPage } from '../modules/sync/SyncConflictsPage';
import { ModulePlaceholder } from '../components/common/ModulePlaceholder';
import {
  ShoppingCart,
  ShoppingBag,
  Boxes,
  Landmark,
  Scale,
  Receipt,
  Users2,
  Users,
  Briefcase,
  PieChart,
  FileSpreadsheet,
  Settings,
  ShieldAlert,
} from 'lucide-react';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: <DashboardPage />,
      },
      {
        path: 'sales',
        element: (
          <ModulePlaceholder
            title="إدارة المبيعات والفواتير"
            subtitle="عروض الأسعار، أوامر البيع، فواتير المبيعات، المردودات وخطط الأقساط (المرحلة 4)"
            icon={ShoppingCart}
          />
        ),
      },
      {
        path: 'pos',
        element: (
          <ModulePlaceholder
            title="نقطة البيع السريعة (POS)"
            subtitle="واجهة الكاشير، فتح وإغلاق الشيفتات، التقرير Z، والدفع المجزأ (المرحلة 8)"
            icon={Receipt}
          />
        ),
      },
      {
        path: 'purchases',
        element: (
          <ModulePlaceholder
            title="إدارة المشتريات والموردين"
            subtitle="أوامر الشراء، فواتير المشتريات، المردودات، وتكاليف الشحن الإضافية Landed Cost (المرحلة 4)"
            icon={ShoppingBag}
          />
        ),
      },
      {
        path: 'inventory',
        element: (
          <ModulePlaceholder
            title="إدارة المستودعات والمخزون"
            subtitle="حركات المخزن، اللوط، تواريخ الصلاحية، الجرد، والتكلفة المرجحة WAC (المرحلة 5)"
            icon={Boxes}
          />
        ),
      },
      {
        path: 'treasury',
        element: (
          <ModulePlaceholder
            title="الخزينة والبنوك والشيكات"
            subtitle="سندات القبض والصرف، دورة حياة الشيكات، مذكرات التسوية البنكية والمصروفات (المرحلة 6)"
            icon={Landmark}
          />
        ),
      },
      {
        path: 'parties',
        element: (
          <ModulePlaceholder
            title="دليل العملاء والموردين"
            subtitle="بيانات الأطراف، الحدود الائتمانية، كشوف الحساب وأعمار الديون (المرحلة 4)"
            icon={Users2}
          />
        ),
      },
      {
        path: 'accounting',
        element: (
          <ModulePlaceholder
            title="المحاسبة العامة وشجرة الحسابات"
            subtitle="دليل الحسابات الهرمي، قيود اليومية، مراكز التكلفة، وإقفال الفترات المالية (المرحلة 3)"
            icon={Scale}
          />
        ),
      },
      {
        path: 'reports',
        element: (
          <ModulePlaceholder
            title="التقارير المالية والتحليلية"
            subtitle="ميزان المراجعة، قائمة الدخل، المركز المالي، التدفقات النقدية، وإقرار ضريبة القيمة المضافة (المرحلة 7)"
            icon={FileSpreadsheet}
          />
        ),
      },
      {
        path: 'hr',
        element: (
          <ModulePlaceholder
            title="الموارد البشرية والرواتب"
            subtitle="سجل الموظفين، شرائح كسب العمل، مسيرات الرواتب الشهرية والسلف (المرحلة 9)"
            icon={Users}
          />
        ),
      },
      {
        path: 'fixed-assets',
        element: (
          <ModulePlaceholder
            title="إدارة الأصول الثابتة"
            subtitle="سجل الأصول، طرق الإهلاك، الإهلاك الشهري والتصرف في الأصول (المرحلة 10)"
            icon={Briefcase}
          />
        ),
      },
      {
        path: 'budgets',
        element: (
          <ModulePlaceholder
            title="الموازنات التقديرية"
            subtitle="الموازنات السنوية لكل فرع ومقارنة التقديري بالفعلي (المرحلة 7)"
            icon={PieChart}
          />
        ),
      },
      {
        path: 'audit',
        element: (
          <ModulePlaceholder
            title="سجل التدقيق والمراجعة"
            subtitle="تتبع كافة العمليات والبيانات المعدلة مع هوية المستخدم والتوقيت"
            icon={ShieldAlert}
          />
        ),
      },
      {
        path: 'backup',
        element: <BackupPage />,
      },
      {
        path: 'sync-conflicts',
        element: <SyncConflictsPage />,
      },
      {
        path: 'settings',
        element: (
          <ModulePlaceholder
            title="إعدادات النظام والفروع"
            subtitle="بيانات المنشأة، الفروع، المستخدمين والمصادقة، وضبط الفاتورة الإلكترونية"
            icon={Settings}
          />
        ),
      },
    ],
  },
]);
