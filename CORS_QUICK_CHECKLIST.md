# Checklist سريعة لحل CORS 403

## أمام إضافة المتغيرات على Vercel (قبل النشر)

### الخطوة 1: فتح Vercel Dashboard
- [ ] اذهب إلى https://vercel.com/dashboard
- [ ] اختر مشروع `chatvidio`
- [ ] اضغط على **Settings**

### الخطوة 2: إضافة Environment Variables
- [ ] من الجانب الأيسر، اختر **Environment Variables**
- [ ] أضف المتغيرات التالية:

**المتغير الأول:**
```
Name: CORS_ORIGIN
Value: https://zoomdz.com,https://www.zoomdz.com
Environment: Production, Preview, Development (اختر الثلاثة)
```

**المتغير الثاني:**
```
Name: PLATFORM_DOMAIN
Value: https://zoomdz.com
Environment: Production, Preview, Development
```

**المتغير الثالث:**
```
Name: NODE_ENV
Value: production
Environment: Production
```

- [ ] تأكد من وجود ✅ بجانب كل متغير

### الخطوة 3: إعادة النشر
```bash
vercel redeploy --prod
```

- [ ] انتظر انتهاء النشر (قد يستغرق 1-3 دقائق)
- [ ] تحقق من حالة النشر: "Deployment Ready"

### الخطوة 4: اختبر الحل
- [ ] افتح: https://zoomdz.com/app.html
- [ ] جرّب تسجيل الدخول
- [ ] يجب أن تظهر رسالة نجاح (لا يجب أن تظهر 403 error)

## إذا استمرت المشكلة

### تصحيح سريع:
1. [ ] امسح كاش المتصفح: Ctrl+Shift+Delete
2. [ ] أعد تحميل الصفحة: Ctrl+F5
3. [ ] جرّب من متصفح آخر

### اختبار متقدم:
افتح F12 وفي Console اكتب:
```javascript
console.log(document.location.origin)
// يجب أن يظهر: https://zoomdz.com أو https://www.zoomdz.com
```

في Network tab:
```
- اختر الطلب الفاشل (POST /api/login)
- انظر إلى Headers
- تحقق من Origin: يجب أن يكون https://www.zoomdz.com أو https://zoomdz.com
```

### للحصول على مساعدة:
اقرأ الملفات:
- `FIX_CORS_403_COMPLETE.md` - توثيق شامل
- `CORS_FIX.md` - توثيق مفصل
- `FIX_LOGIN_403.md` - خطوات سريعة
