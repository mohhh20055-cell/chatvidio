# حل المشاكل الشائعة

## مشاكل reCAPTCHA

### المشكلة: الكابتشا لا تعمل على Vercel بينما تعمل على Render

#### السبب الرئيسي:
`RECAPTCHA_SECRET_KEY` لم يتم إضافته إلى متغيرات البيئة على Vercel.

#### الحل:

**الخطوة 1: التحقق من متغيرات البيئة**
1. اذهب إلى [Vercel Dashboard](https://vercel.com/dashboard)
2. انتقل إلى مشروع `chatvidio`
3. اذهب إلى **Settings** → **Environment Variables**
4. تحقق من وجود:
   - ✅ `RECAPTCHA_SITE_KEY`
   - ✅ `RECAPTCHA_SECRET_KEY`

**الخطوة 2: إضافة المتغيرات إذا كانت مفقودة**

```bash
# استخدام Vercel CLI
vercel env add RECAPTCHA_SITE_KEY
# اختر: Production, Preview, Development
# أدخل القيمة: 6Lcv8kctAAAAAHcoWBv_e87vrjP7I6IzQJSV6THf

vercel env add RECAPTCHA_SECRET_KEY
# اختر: Production, Preview, Development
# أدخل القيمة: [المفتاح السري من Google]
```

**الخطوة 3: إعادة النشر**
```bash
vercel redeploy --prod
```

### المشكلة: "Invalid site key"

#### الأسباب المحتملة:
1. المفتاح مختلف بين الواجهة الأمامية والخادم
2. الدومين غير مضاف في Google reCAPTCHA Console
3. مسافات في بداية أو نهاية المفتاح

#### الحل:

**أ. التحقق من المفتاح في الواجهة الأمامية**
```javascript
// في DevTools Console
console.log(window.RECAPTCHA_SITE_KEY)
// يجب أن تظهر: 6Lcv8kctAAAAAHcoWBv_e87vrjP7I6IzQJSV6THf
```

**ب. التحقق من الدومين في Google**
1. اذهب إلى [reCAPTCHA Admin](https://www.google.com/recaptcha/admin)
2. انتقل إلى موقعك `zoomdz Platform`
3. تحقق من أن الدومين مضاف:
   - ✅ zoomdz.com
   - ✅ www.zoomdz.com
   - ✅ localhost (للتطوير)
   - ✅ *.vercel.app (للتجريب)

**ج. إزالة المسافات**
تأكد من عدم وجود مسافات في نسخ المفتاح.

### المشكلة: "Error: socket hang up" أو "ECONNREFUSED"

#### السبب:
لا يستطيع الخادم الاتصال بـ Google reCAPTCHA.

#### الحل:

**أ. التحقق من الاتصال بالإنترنت**
```bash
ping www.google.com
```

**ب. التحقق من Firewall**
قد يكون Vercel يحظر الاتصالات الخارجية. تواصل مع دعم Vercel.

**ج. استخدام Proxy**
إذا كان في بيئة حكومية، قد تحتاج لاستخدام proxy.

### المشكلة: "Verify timeout"

#### السبب:
الطلب استغرق وقتاً طويلاً جداً.

#### الحل:

```javascript
// في /utils/validation.js - الـ timeout تم زيادته إلى 10 ثوانٍ
timeout: 10000

// إذا كان لا يزال يحدث timeout:
// جرّب تقليل الضغط على الخادم
// أو تواصل مع Google Support
```

### المشكلة: صندوق reCAPTCHA لا يظهر إطلاقاً

#### تشخيص:

**الخطوة 1: تحقق من console للأخطاء**
```javascript
// اضغط F12 وراقب Console
// يجب أن تظهر رسائل مثل:
// ✅ onRecaptchaLoaded تم استدعاؤها
// ✅ تم عرض reCAPTCHA لنوع: login
```

**الخطوة 2: تحقق من أن grecaptcha محمل**
```javascript
typeof grecaptcha // يجب أن يكون "object"
```

**الخطوة 3: تحقق من RECAPTCHA_SITE_KEY**
```javascript
window.RECAPTCHA_SITE_KEY // يجب أن يكون القيمة الصحيحة
```

#### الحل:

إذا لم تظهر أي رسائل:
1. تأكد من تحميل السكريبت:
   ```html
   <!-- في index.html -->
   <script src="https://www.google.com/recaptcha/api.js?onload=onRecaptchaLoaded&render=explicit"></script>
   ```

2. تأكد من تحميل recaptcha.js:
   ```html
   <script src="/js/recaptcha.js"></script>
   ```

3. قد يكون هناك مشكلة CORS - اعتبر تحديث server.js

### المشكلة: "Failed to verify at time of use"

#### السبب:
الرمز انتهت صلاحيته أو تم استخدامه مسبقاً.

#### الحل:

```javascript
// في recaptcha.js - الرمز يصلح لـ 2 دقيقة فقط
// لذا لا تأخذ وقت طويل قبل الإرسال

// جرّب:
// 1. أكمل التحقق بسرعة
// 2. أرسل البيانات مباشرة بعد النقر على الصندوق
```

---

## مشاكل CORS

### المشكلة: "Access to XMLHttpRequest blocked by CORS policy"

#### الحل:

**الخطوة 1: تحقق من CORS_ORIGIN في Vercel**
```bash
# يجب أن تتضمن:
CORS_ORIGIN=https://zoomdz.com,https://www.zoomdz.com,http://localhost:3000
```

**الخطوة 2: تحديث server.js**
```javascript
// في server.js - تم الفعل بالفعل
const CORS_ORIGIN = process.env.CORS_ORIGIN ? 
    process.env.CORS_ORIGIN.split(',') : 
    ['https://zoomdz.com', 'https://www.zoomdz.com', ...];

app.use(cors({
    origin: isOriginAllowed,
    credentials: true
}));
```

**الخطوة 3: إعادة النشر**
```bash
vercel redeploy --prod
```

---

## مشاكل الواجهة الأمامية

### المشكلة: responsive design سيء على الهاتف

#### الحل:
تم حلها في آخر تحديث. إذا استمرت:

```bash
# امسح الـ Cache
CTRL + SHIFT + DEL (اختر Cached Images and Files)

# أو اضغط
CTRL + F5 (Hard Refresh)

# على الهاتف: أغلق التطبيق وأعد فتحه
```

---

## مشاكل البيانات

### المشكلة: البيانات لا تظهر على Vercel

#### السبب:
متغيرات Supabase غير صحيحة.

#### الحل:

**الخطوة 1: تحقق من متغيرات Supabase**
```bash
# يجب أن تكون موجودة:
SUPABASE_URL
SUPABASE_KEY
```

**الخطوة 2: انسخها من Supabase**
1. اذهب إلى [Supabase Dashboard](https://app.supabase.com)
2. انتقل إلى مشروعك
3. اذهب إلى **Settings** → **API**
4. نسخ:
   - Project URL → `SUPABASE_URL`
   - anon public → `SUPABASE_KEY`

**الخطوة 3: أضفها إلى Vercel**
```bash
vercel env add SUPABASE_URL
vercel env add SUPABASE_KEY
vercel redeploy --prod
```

---

## مشاكل البريد الإلكتروني

### المشكلة: لا تصل رسائل البريد

#### الحل:

**تحقق من Resend API Key:**
```bash
vercel env add RESEND_API_KEY
# احصل عليها من https://resend.com/api-keys
```

**تحقق من البريد في Spam:**
أحياناً تذهب الرسائل إلى Spam.

---

## أوامر مفيدة

```bash
# عرض جميع متغيرات البيئة
vercel env ls

# إضافة متغير جديد
vercel env add VAR_NAME

# إزالة متغير
vercel env rm VAR_NAME

# إعادة نشر الإنتاج
vercel redeploy --prod

# عرض السجلات
vercel logs --prod

# إعادة تشغيل محلي
npm run dev

# بناء الإنتاج محلياً
npm run build
```

---

## الاتصال بالدعم

إذا لم ينجح أي من الحلول:

1. **Vercel Support**: https://vercel.com/help
2. **Google reCAPTCHA**: https://support.google.com/recaptcha
3. **Supabase Support**: https://supabase.com/support
4. **Community**: Stack Overflow, GitHub Issues

---

**آخر تحديث**: يناير 2024  
**الحالة**: ✅ معظم المشاكل تم حلها
