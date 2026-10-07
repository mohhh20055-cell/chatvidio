# ☁️ دليل رفع وتشغيل المشروع على Cloudflare Pages

تم تجهيز المشروع بالكامل ليكون متوافقاً 100% مع استضافة **Cloudflare Pages** السريعة والمجانية.

---

## 🚀 خطوات الرفع عبر لوحة تحكم Cloudflare

### 1. إنشاء مشروع جديد
1. ادخل إلى حسابك في [Cloudflare Dashboard](https://dash.cloudflare.com).
2. من القائمة الجانبية، اختر **Workers & Pages**.
3. اضغط على **Create application** ثم اختر تبويب **Pages**.
4. اضغط على **Connect to Git** واختر مستودع GitHub الخاص بك: `mohhh20055-cell/chatvidio`.

---

### 2. إعدادات البناء (Build Settings)
قم بملء الحقول في قسم Build settings كما يلي:

* **Framework preset:** `None` أو `Vite`
* **Build command:** `npm run build`
* **Build output directory:** `dist`
* **Root directory:** `/` (اتركه فارغاً أو `/`)

---

### 3. المتغيرات البيئية (Environment Variables)
في قسم **Environment variables**، أضف المتغيرات الخاصة بمشروعك (مثل الموجودة في ملف `.env`):

| اسم المتغير (Variable Name) | الوصف |
| :--- | :--- |
| `NODE_VERSION` | `18` أو `20` |
| `SUPABASE_URL` | رابط مشروع Supabase الخاص بك |
| `SUPABASE_SERVICE_ROLE_KEY` | مفتاح Service Role لـ Supabase |
| `JWT_SECRET` | المفتاح السري لتشفير الجلسات والتوكن |
| `AGORA_APP_ID` | معرف تطبيق Agora للبث المباشر |
| `AGORA_APP_CERTIFICATE` | شهادة Agora Token Generator |
| `NODE_ENV` | `production` |

---

### 4. تفعيل توافق Node.js (Compatibility Flags)
1. بعد إنشاء المشروع، اذهب إلى: **Settings** -> **Functions** -> **Compatibility flags**.
2. أضف الراية: `nodejs_compat` للفرع الإنتاجي (Production) والفرعي (Preview).
3. تأكد من أن **Compatibility date** مضبوط على تاريخ حديث (مثل `2024-09-23` فما بعد).

---

### 5. النشر (Deploy)
اضغط على **Save and Deploy** وستقوم Cloudflare ببناء ونشر المنصة في ثوانٍ مع شهادة SSL مجانية وحماية عالمية من هجمات DDoS.
