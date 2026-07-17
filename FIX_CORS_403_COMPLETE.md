# حل شامل لخطأ CORS 403 على Vercel

## المشكلة
خطأ: **"غير مسموح به من هذا المصدر"** عند تسجيل الدخول على Vercel
- تظهر الرسالة: `❌ رفض المصدر: https://www.zoomdz.com`
- لكن `https://zoomdz.com` موجود في القائمة المسموحة

## السبب الرئيسي
متغير البيئة `CORS_ORIGIN` لم يتم إضافته إلى Vercel Dashboard، لذلك يتم استخدام القيمة الافتراضية من الكود، وهناك مشكلة في معالجة النطاقات.

## الحلول المطبقة

### 1. تحسين معالجة CORS_ORIGIN في server.js
- فصل القيمة الافتراضية إلى `DEFAULT_CORS_ORIGINS`
- إضافة معالجة أفضل للفراغات والقيم الفارغة
- إضافة logging للتصحيح

### 2. تحسين دالة isOriginAllowed()
- إضافة escape صحيح للأحرف الخاصة في regex
- إضافة logging عند رفض المصدر
- معالجة أفضل للـ wildcards

### 3. تحسين CORS middleware
- السماح بالطلبات بدون Origin header
- معالجة أفضل للأخطاء
- إضافة معالج OPTIONS منفصل

### 4. ملفات جديدة
- `.env.production` - متغيرات الإنتاج
- `FIX_CORS_403_COMPLETE.md` - هذا الملف

## خطوات الإصلاح الفورية

### الخطوة 1: إضافة متغيرات إلى Vercel
1. اذهب إلى: https://vercel.com/dashboard
2. اختر مشروع `chatvidio`
3. **Settings** → **Environment Variables**
4. أضف المتغيرات التالية:

```
CORS_ORIGIN
Value: https://zoomdz.com,https://www.zoomdz.com,http://localhost:3000

PLATFORM_DOMAIN
Value: https://zoomdz.com

NODE_ENV
Value: production
```

5. تأكد من تحديد: **Production** و **Preview** و **Development**

### الخطوة 2: إعادة النشر
```bash
vercel redeploy --prod
```

### الخطوة 3: اختبر من الفور
```bash
# 1. افتح: https://zoomdz.com/app.html
# 2. جرّب تسجيل الدخول
# 3. تحقق من وحدة تحكم المتصفح (F12) من الأخطاء
```

## المتغيرات المطلوبة على Vercel

| المتغير | القيمة | ملاحظات |
|--------|--------|--------|
| `CORS_ORIGIN` | `https://zoomdz.com,https://www.zoomdz.com` | ⭐ مهم جداً |
| `PLATFORM_DOMAIN` | `https://zoomdz.com` | النطاق الرئيسي |
| `NODE_ENV` | `production` | بيئة الإنتاج |
| `SUPABASE_URL` | من Supabase | قاعدة البيانات |
| `SUPABASE_KEY` | من Supabase | API Key |
| `RECAPTCHA_SITE_KEY` | من Google | الكابتشا |
| `RECAPTCHA_SECRET_KEY` | من Google | الكابتشا السري |
| `JWT_SECRET` | مفتاح سري | التوثيق |

## تصحيح المشاكل الأخرى المكتشفة

### مشكلة: فشل في إنشاء مجلد السجلات
```
❌ فشل في إنشاء مجلد السجلات: ENOENT: no such file or directory, mkdir '/var/task/logs'
```
**الحل**: Vercel يستخدم `/tmp` للملفات المؤقتة
- تم تحديث logger.js ليستخدم `/tmp/logs` بدلاً من `./logs`

### مشكلة: فشل في كتابة config.js
```
❌ فشل في كتابة config.js: EROFS: read-only file system
```
**الحل**: Vercel لديه read-only file system
- تم استخدام middleware لتقديم config.js بدلاً من كتابة ملف

## اختبار الحل

### من DevTools (F12)
```javascript
// تحقق من CORS_ORIGIN المحملة
console.log(document.location.origin);
// يجب أن يظهر: https://www.zoomdz.com أو https://zoomdz.com
```

### من Terminal
```bash
curl -H "Origin: https://www.zoomdz.com" \
  -X OPTIONS \
  https://zoomdz.com/api/login \
  -v

# تحقق من:
# - Access-Control-Allow-Origin: https://www.zoomdz.com
# - HTTP Status: 200 OK
```

## المشاكل الشائعة والحلول

### ✗ لا تزال الخطأ موجودة؟
1. **تأكد من إضافة المتغيرات على Vercel**
   - Dashboard → Settings → Environment Variables
   - يجب أن يكون هناك 3 نقاط خضراء بجانب المتغير

2. **أعد النشر بعد إضافة المتغيرات**
   ```bash
   vercel redeploy --prod
   ```

3. **امسح الكاش من المتصفح**
   - Ctrl+Shift+Delete (اختر "الكاش")
   - ثم أعد تحميل الصفحة

4. **تحقق من Origin في DevTools**
   - Network → app.html → الطلب الفاشل
   - انظر إلى Origin header
   - تأكد أنه يطابق قيمة في CORS_ORIGIN

### ✓ الخطأ حُلّ؟
- يجب أن تظهر رسالة "تم تسجيل الدخول بنجاح"
- ستُعاد التوجيه إلى dashboard الخاص بك

## ملاحظات أمان

⚠️ **لا تنسَ**:
- حفظ `RECAPTCHA_SECRET_KEY` في Vercel فقط
- عدم نشر `JWT_SECRET` في GitHub
- استخدام HTTPS دائماً في الإنتاج
- تغيير المفاتيح كل 3-6 أشهر

## التحديثات الحديثة

- ✅ تحسين معالجة CORS_ORIGIN
- ✅ تحسين دالة isOriginAllowed()
- ✅ إضافة logging للتصحيح
- ✅ دعم OPTIONS preflight
- ✅ معالجة أفضل للأخطاء
