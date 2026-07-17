# 🚀 حل سريع: خطأ تسجيل الدخول 403

## المشكلة
```
❌ POST /api/login - 403 Forbidden
❌ "غير مسموح به من هذا المصدر"
```

## الحل (2 دقيقة فقط)

### الخطوة 1: أضف متغير البيئة
1. اذهب إلى: **https://vercel.com/dashboard**
2. اختر مشروع **chatvidio**
3. **Settings** → **Environment Variables**
4. **Add New**:
   ```
   Name:  CORS_ORIGIN
   Value: https://zoomdz.com,https://www.zoomdz.com,http://localhost:3000
   ```
5. اختر: **Production** ✅ و **Preview** ✅
6. انقر **Add**

### الخطوة 2: أعد النشر
```bash
vercel redeploy --prod
```

### الخطوة 3: اختبر
- اذهب إلى https://zoomdz.com/app.html
- جرب تسجيل الدخول
- ✅ يجب أن يعمل الآن!

---

## إذا لم يعمل

### تحقق من الـ Logs:
```bash
vercel logs [project-name] --prod
```
ابحث عن:
- `✅ مصدر مسموح` = يعمل
- `❌ رفض المصدر` = لم يتم إضافة المتغير بشكل صحيح

### تأكد من:
1. ✅ تم إضافة `CORS_ORIGIN` بالضبط كما هو مكتوب
2. ✅ تم اختيار **Production** و **Preview**
3. ✅ في انتظار 2-3 دقائق بعد الإضافة
4. ✅ أعدت النشر مع `vercel redeploy --prod`

---

## معلومات إضافية
- انظر `CORS_FIX.md` للتفاصيل الكاملة
- المشكلة شائعة عند الانتقال من استضافة لأخرى
