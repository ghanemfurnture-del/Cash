# وثيقة تصميم النسخ الاحتياطي اليومي الخارجي (Phase 2b-3c)
# External Daily Automated Backup Architecture (Option 2)

> **القرار المعتمد:** الخيار 2 — سكريبت Windows PowerShell يعمل يومياً عبر جدولة مهام ويندوز (Windows Task Scheduler) على جهاز المكتب الرئيسي، مع التشفير بالمفتاح العام (Asymmetric Public-Key Encryption) وإدارة الأسرار عبر Windows Credential Manager / DPAPI.

---

## 1. المعمارية ونظرة عامة (Architecture Overview)

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SUPABASE CLOUD POSTGRES                         │
│                    (EU Central / AWS / Port 5432/6543)                 │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
              pg_dump over TLS (SSL mode = require)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      WINDOWS CLIENT MACHINE (PC)                       │
│                                                                        │
│  [Windows Task Scheduler] ──> [daily_backup.ps1]                       │
│                                   │                                    │
│   1. Retrieve DB Password ◄───────┴─ [Windows Credential Manager]      │
│   2. Execute pg_dump -Fc (Custom compressed archive)                   │
│   3. Asymmetric Encryption ───────> [Owner Public Key (age/OpenSSL)]   │
│   4. Apply GFS Retention (14 Daily / 8 Weekly / 12 Monthly)            │
│   5. Health Check & Logging ──────> [Event Log / Windows Toast Alert]  │
│                                                                        │
│   * Result: Encrypted Backup Archive: backup_YYYYMMDD_HHMMSS.dump.enc  │
│   * Security: Private Key is OFFLINE with the Business Owner           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. تفاصيل الاتصال وأداة `pg_dump`

### 2.1 صيغة النسخة (Dump Format)
- نستخدم الصيغة المخصصة المضغوطة لبوستجريس: `pg_dump -F c -Z 6 -b -v`
  - `-F c`: Custom format (تسمح لـ `pg_restore` بالاستعادة المتوازية واختيار جداول محددة).
  - `-Z 6`: ضغط داخلي عالي الكفاءة (Gzip level 6).
  - `-b`: تضمين الكائنات الثنائية الكبيرة (Blobs/Large Objects).
  - `-v`: وضع التفاصيل (Verbose logging).

### 2.2 وسائط الاتصال وشبكات IPv4 / IPv6
- **خطة Supabase المجانية وشبكات IPv4:**
  - الاتصال المباشر بقاعدة بيانات Supabase (`db.<project-ref>.supabase.co:5432`) يتطلب دعماً لـ IPv6 في مزود خدمة الإنترنت المحلي.
  - في حال كان مزود الإنترنت المصري (WE / Vodafone / Orange) لا يدعم IPv6 على الخط الأرضي، نستخدم عنوان موزع الاتصال **Supabase Session Pooler**:
    - Host: `aws-0-eu-central-1.pooler.supabase.com` (أو المنطقة المناسبة لمشروعك).
    - Port: `5432` (Session mode) أو `6543` (Transaction mode - لا يصلح لـ pg_dump، يجب استخدام 5432 Session Mode).
    - User: `postgres.<project-ref>`
  - يضمن ذلك اتصالاً مستقراً عبر بروتوكول IPv4 القياسي.

---

## 3. التشفير غير المتماثل (Asymmetric Public-Key Encryption)

> **قاعدة ذهبية للأمان:** حتى لو سُرق جهاز الكمبيوتر الذي ينفذ النسخ، أو تم اختراق نظام التشغيل، لا يستطيع المهاجم قراءة البيانات المحاسبية للمنشأة نهائياً.

### 3.1 كيف يعمل؟
1. يمتلك **مالك المنشأة** زوج مفاتيح مشفر (Public Key + Private Key):
   - **المفتاح العام (Public Key):** يُوضع داخل جهاز النسخ التلقائي ليقوم السكريبت بتشفير النسخة فور الانتهاء منها. المفتاح العام يشفر فقط ولا يملك صلاحية فك التشفير.
   - **المفتاح الخاص (Private Key):** يُحفظ **أوفلاين** في وحدة تخزين آمنة لدى المالك (فلاش ميموري مشفرة أو مدير كلمات مرور آمن). لا يتواجد نهائياً على جهاز السيرفر أو جهاز النسخ.
2. الأدوات المعتمدة للتشفير غير المتماثل:
   - **أداة age (موصى بها بشدة لسهولتها):**
     - التشفير: `age -r age1ql3z7hjy... -o backup.dump.enc backup.dump`
   - **أداة OpenSSL (متوفرة افتراضياً مع Git for Windows):**
     - التشفير: `openssl cms -encrypt -aes256 -recip owner_cert.pem -in backup.dump -out backup.dump.enc -outform DER`

---

## 4. إدارة الأسرار محلياً (Zero Hardcoded Secrets)

- **حظر تام:** يُمنع كتابة كلمة المرور أو معرّف المشروع داخل السكريبت `daily_backup.ps1`.
- **التخزين الآمن عبر Windows Credential Manager:**
  - يتم تخزين كلمة المرور في خزنة ويندوز الآمنة (Windows Vault) تحت الهدف: `CashERP_DatabaseBackup`.
  - الأمر لحفظ السر أول مرة:
    ```powershell
    cmdkey /generic:CashERP_DatabaseBackup /user:postgres.<project-ref> /pass:YourSecretPassword
    ```
  - يقرأ السكريبت السر عبر واجهة `Get-Credential` أو DPAPI دون إظهار كلمة المرور في الشاشة أو السجلات.

---

## 5. سياسة الاحتفاظ (GFS Retention Policy)

يقوم السكريبت تلقائياً بتصنيف النسخ وإدارتها وفق سياسة الأجداد والآباء والأبناء (GFS):
1. **النسخ اليومية (Daily):** الاحتفاظ بآخر **14 نسخة يومية**.
2. **النسخ الأسبوعية (Weekly):** الاحتفاظ بآخر **8 نسخ أسبوعية** (النسخة الصادرة يوم الجمعة).
3. **النسخ الشهرية (Monthly):** الاحتفاظ بآخر **12 نسخة شهرية** (النسخة الصادرة في اليوم الأول من كل شهر).
4. **التنظيف التلقائي:** يتم فحص المجلد بعد كل عملية وحذف النسخ الأقدم من المدد المحددة، لمنع استهلاك مساحة القرص الصلب.

---

## 6. المراقبة والتنبيهات (Monitoring & Alerting)

1. **ملف السجلات (`logs/backup_YYYYMM.log`):**
   - يسجل السكريبت توقيت البدء، حجم الملف الناتج، مدة التنفيذ، وحالة النجاح أو الفشل.
   - لا تُسجل أي كلمات مرور أو مفاتيح تشفير داخل السجل نهائياً.
2. **فحص السلامة (Health Check):**
   - يفحص السكريبت تاريخ أحدث ملف نسخة ناجحة.
   - إذا مضى **أكثر من 48 ساعة (يومين)** دون إنتاج نسخة جديدة ناجحة، يتم:
     - إطلاق إشعار نظام ويندوز (Windows Toast Notification) ينبه المحاسب أو مدير النظام.
     - تسجيل حدث تحذيري في سجل أحداث ويندوز (Windows Event Log: Event ID 9001).

---

## 7. تمرين الاستعادة والاختبار (Restore Drill Guide)

> يجب على مسؤول النظام إجراء هذا التمرين في بيئة تجريبية معزولة (Local Docker أو فرع تجريبي) كل 6 أشهر للتأكد من سلامة النسخ.

### الخطوة 1: جلب النسخة المشفرة والمفتاح الخاص
1. انسخ الملف المشفر `backup_20261104_020000.dump.enc` إلى جهاز الاختبار المعزول.
2. قم بتوصيل وسيط التخزين الآمن الذي يحتوي على المفتاح الخاص للمالك `owner_private_key.txt`.

### الخطوة 2: فك التشفير
- باستخدام أداة age:
  ```bash
  age --decrypt -i owner_private_key.txt -o restored.dump backup_20261104_020000.dump.enc
  ```
- أو باستخدام OpenSSL:
  ```bash
  openssl cms -decrypt -in backup_20261104_020000.dump.enc -inform DER -inkey owner_private_key.pem -out restored.dump
  ```

### الخطوة 3: الاستعادة في قاعدة بيانات تجريبية
```bash
createdb -h localhost -p 5432 -U postgres cash_drill_test
pg_restore -h localhost -p 5432 -U postgres -d cash_drill_test -v --clean --if-exists restored.dump
```

### الخطوة 4: التحقق من صحة واكتمال البيانات
افتح `psql` على قاعدة البيانات التجريبية ونفّذ:
```sql
-- 1. التأكد من عدد الجداول والصفوف الأساسية
SELECT count(*) FROM items;
SELECT count(*) FROM documents;
SELECT count(*) FROM document_lines;
SELECT count(*) FROM sync_ops;

-- 2. التأكد من عمل محفزات الحصانة (Immutability Triggers)
SELECT id, status, total FROM documents WHERE status = 'posted' LIMIT 1;
```

---

## 8. وضع ملفات التخزين السحابي (Supabase Storage)

- **تنبيه:** أداة `pg_dump` تقوم بنسخ جداول وبيانات قاعدة البيانات فقط، ولا تشمل المرفقات الثنائية المخزنة في Supabase Storage (مثل صور الفواتير الورقية أو ملفات PDF).
- في حال تفعيل المرفقات في مراحل متقدمة، يتم جدولة سكريبت مكمل يعتمد على أداة `rclone` أو بروتوكول S3-Compatible لنسخ مجلدات التخزين السحابي بصيغة مشفرة.

---

## 9. إعداد مهمة Windows Task Scheduler

### الطريقة 1: عبر سطر الأوامر (Command Line)
```powershell
schtasks /Create /TN "CashERP_DailyBackup" /XML "scripts\backup\backup_task_scheduler.xml"
```

### الطريقة 2: عبر واجهة مستخدم Task Scheduler GUI
1. افتح **Task Scheduler** من قائمة ابدأ في ويندوز.
2. اضغط على **Action** -> **Import Task...**
3. اختر الملف `scripts\backup\backup_task_scheduler.xml`.
4. حدد حساب المستخدم المخصص للتشغيل وتأكد من تفعيل "Run whether user is logged on or not".

---

## 10. مصفوفة المخاطر والإجراءات الوقائية (Risks & Mitigations)

| المخاطرة | الاحتمالية | الأثر | الإجراء الوقائي |
| :--- | :---: | :---: | :--- |
| **الجهاز مغلق وقت الجدولة** | متوسط | متوسط | ضبط خيار `StartWhenAvailable = true` في Task Scheduler لتشغيل المهمة فور إقلاع الجهاز في الصباح. |
| **سرقة أو اختراق جهاز النسخ** | منخفض | كارثي لو لم يُشفر | **التشفير غير المتماثل:** السارق يجد ملفات مشفرة لا يمكن فكها لأن المفتاح الخاص غير موجود على الجهاز. |
| **فقدان المفتاح الخاص للمالك** | منخفض | كارثي | حفظ نسختين ورقيتين (Paper Key) ونسختين على وسائط USB مشفرة في خزنتين منفصلتين للمنشأة. |
| **توقف مشروع Supabase المجاني** | متوسط | عالي | الاتصال اليومي المجدول للنسخ يُعد نشاطاً برمجياً نشطاً يمنع تجميد المشروع السحابي تلقائياً (Anti-Pause Activity). |
| **امتلاء مساحة القرص الصلب** | متوسط | منخفض | تطبيق سياسة الاحتفاظ GFS وحذف النسخ القديمة تلقائياً، مع التنبيه عند نقص المساحة عن 5 جيجابايت. |

