# حل سريع: الكابتشا على Vercel في 5 دقائق

## المشكلة
الكابتشا تعمل على Render لكن لا تعمل على Vercel.

## الحل (خطوات سريعة)

### الخطوة 1: الحصول على المفاتيح (إذا لم تكن لديك)
1. اذهب إلى: https://www.google.com/recaptcha/admin
2. انقر "+"
3. أدخل:
   - **Label**: zoomdz
   - **Type**: reCAPTCHA v2 (I'm not a robot)
   - **Domains**: zoomdz.com, www.zoomdz.com, localhost
4. انقر "Create"
5. نسخ المفاتيح الظاهرة

### الخطوة 2: إضافة المفاتيح إلى Vercel

**الطريقة الأسهل - عبر Dashboard:**

1. اذهب إلى: https://vercel.com/dashboard
2. اختر مشروع `chatvidio`
3. **Settings** ← **Environment Variables**
4. أضف المتغيرات:

```
متغير: RECAPTCHA_SITE_KEY
القيمة: 6Lcv8kctAAAAAHcoWBv_e87vrjP7I6IzQJSV6THf
(أو المفتاح الذي حصلت عليه من Google)

متغير: RECAPTCHA_SECRET_KEY
القيمة: [المفتاح السري الطويل من Google]
```

5. اختر: **Production** و **Preview** و **Development** ✅
6. اضغط **"Save"**

### الخطوة 3: إعادة النشر
```bash
vercel redeploy --prod
```

أو من Dashboard: **Deployments** → **Redeploy** → **Production**

### الخطوة 4: اختبار
1. افتح: https://zoomdz.com
2. اذهب إلى صفحة التسجيل
3. يجب أن تظهر صندوق "I'm not a robot"

## ✅ نجح!

إذا ظهرت الصندوق، الكابتشا تعمل الآن.

---

## 🔧 Troubleshooting سريع

### ❌ لا تظهر الصندوق
```javascript
// اضغط F12 في المتصفح واكتب:
console.log(window.RECAPTCHA_SITE_KEY)
// يجب أن يظهر مفتاح - إن لم يظهر، المفتاح غير مضبوط
```

### ❌ تظهر رسالة خطأ
- تأكد من أن المفتاح السري مطابق تماماً (بدون مسافات)
- تحقق من أن الدومين مضاف في Google reCAPTCHA

### ❌ تظهر الصندوق لكن التسجيل فشل
```bash
# شغّل الأوامر التالية:
vercel logs --prod
# ابحث عن "RECAPTCHA" أو "verify" في السجلات
```

---

## 📞 تحتاج مساعدة إضافية؟

- اقرأ: `RECAPTCHA_SETUP.md` (توثيق كامل)
- اقرأ: `TROUBLESHOOTING.md` (حل 20+ مشكلة)
- تواصل: github.com/mohhh20055-cell/chatvidio/issues

---

**الوقت المتوقع**: 5 دقائق  
**الصعوبة**: سهل جداً ✅
