# إعداد reCAPTCHA على منصة zoomdz

## المشكلة
الكابتشا تعمل على Render لكن لا تعمل على Vercel بسبب عدم إضافة متغيرات البيئة بشكل صحيح.

## الحل

### 1. الحصول على مفاتيح Google reCAPTCHA

#### أ. إنشاء مشروع على Google Cloud Console
1. اذهب إلى [Google Cloud Console](https://console.cloud.google.com)
2. أنشئ مشروع جديد باسم "zoomdz"
3. فعّل reCAPTCHA API

#### ب. الذهاب إلى reCAPTCHA Admin Console
1. اذهب إلى [reCAPTCHA Admin Console](https://www.google.com/recaptcha/admin)
2. انقر على "+" لإنشاء موقع جديد
3. أدخل البيانات التالية:

**تفاصيل الموقع:**
- **Label**: zoomdz Platform
- **reCAPTCHA type**: reCAPTCHA v2 (I'm not a robot. Checkbox)
- **Domains**:
  ```
  zoomdz.com
  www.zoomdz.com
  zoomdz-*.vercel.app
  chatvidio.vercel.app
  localhost
  ```

4. اقبل شروط الخدمة وانقر "Create"

#### ج. نسخ المفاتيح
ستحصل على:
- **Site Key** (المفتاح العام) - يستخدم في الواجهة الأمامية
- **Secret Key** (المفتاح السري) - يستخدم في الخادم

### 2. إضافة المتغيرات إلى Vercel

#### الطريقة الأولى: عبر لوحة التحكم Vercel
1. اذهب إلى [Vercel Dashboard](https://vercel.com/dashboard)
2. انتقل إلى مشروع `chatvidio`
3. اذهب إلى **Settings** → **Environment Variables**
4. أضف المتغيرات التالية:

| متغير | القيمة | الملاحظة |
|-------|--------|---------|
| `RECAPTCHA_SITE_KEY` | المفتاح العام من Google | يمكن أن يكون عام (لا يوجد خطورة) |
| `RECAPTCHA_SECRET_KEY` | المفتاح السري من Google | **يجب إبقاؤه سري** - فقط على الخادم |

5. أضف هذه المتغيرات لجميع البيئات:
   - ✅ Development
   - ✅ Preview
   - ✅ Production

#### الطريقة الثانية: عبر Vercel CLI
```bash
vercel env add RECAPTCHA_SITE_KEY
vercel env add RECAPTCHA_SECRET_KEY
```

### 3. التحقق من الإعدادات

#### أ. التحقق من الخادم
```bash
# على Vercel Logs
# يجب أن ترى:
# "✅ تم التحقق من reCAPTCHA بنجاح - Score: 0.X"
```

#### ب. اختبار الكابتشا
1. افتح الموقع على https://zoomdz.com
2. اذهب إلى صفحة التسجيل
3. يجب أن تظهر صندوق reCAPTCHA

#### ج. فحص الأخطاء
إذا لم تظهر:
```javascript
// افتح DevTools (F12) واكتب:
console.log(window.RECAPTCHA_SITE_KEY)
console.log(grecaptcha) // يجب أن يكون معرّف
```

### 4. الأخطاء الشائعة والحلول

#### ❌ خطأ: "RECAPTCHA_SECRET_KEY غير موجود"
**الحل:**
1. تأكد من إضافة المتغير في Vercel Settings
2. أعد تشغيل الـ Deployment
3. تحقق من اسم المتغير تماماً (Case-sensitive)

#### ❌ خطأ: "Invalid site key"
**الحل:**
1. تأكد من نسخ المفتاح بشكل صحيح
2. تأكد من عدم وجود مسافات في البداية أو النهاية
3. تحقق من أن الدومين مضاف في Google reCAPTCHA Console

#### ❌ خطأ: "Verify timeout"
**الحل:**
1. تأكد من اتصال الخادم بالإنترنت
2. قد يكون حظر firewall - تواصل مع دعم Vercel
3. جرّب استخدام VPN

#### ❌ لا تظهر صندوق reCAPTCHA
**الحل:**
1. تحقق من أن `RECAPTCHA_SITE_KEY` موجود
2. تحقق من تحميل السكريبت: `https://www.google.com/recaptcha/api.js`
3. افتح DevTools وابحث عن أخطاء

### 5. الملفات المتعلقة

- **Frontend**: `/public/js/recaptcha.js` - يستخدم RECAPTCHA_SITE_KEY
- **Backend**: `/utils/validation.js` - يستخدم RECAPTCHA_SECRET_KEY
- **Auth Routes**: `/routes/auth.js` - يتحقق من الرمز

### 6. تحديث تلقائي للمفاتيح

إذا أضفت/غيرت المفاتيح:
1. أعد تشغيل الـ Deployment على Vercel
2. أو استخدم `vercel redeploy`

```bash
vercel redeploy --prod
```

### 7. اختبار محلي (Local Testing)

أنشئ ملف `.env.local`:
```
RECAPTCHA_SITE_KEY=your_site_key_here
RECAPTCHA_SECRET_KEY=your_secret_key_here
```

ثم شغّل:
```bash
npm run dev
```

### 8. الأمان والنصائح

✅ **افعل:**
- احفظ Secret Key في متغيرات البيئة فقط
- لا تنشر المفتاح السري في GitHub
- استخدم الدومين الصحيح عند الإنشاء
- تحديث المفاتيح كل 3-6 أشهر

❌ **لا تفعل:**
- لا تضع المفتاح السري في الكود الأمامي
- لا تستخدم نفس المفتاح لعدة مشاريع
- لا تنسخ المفاتيح من screenshots

---

**نسخة المستند**: 1.0  
**آخر تحديث**: يناير 2024  
**الحالة**: ✅ مختبرة وتعمل على Vercel
