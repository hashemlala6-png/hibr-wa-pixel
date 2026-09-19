# حبر وبكسل — Clean Production Build

هذه النسخة هي نسخة إنتاج نظيفة من المشروع الحالي، وليست طبقة فوق نسخة سابقة.

## البنية
- الواجهة العامة: صفحات HTML + `public.css` + `public.js`
- حساب العميل: `login.html` و`account.html` و`onboarding.html`
- الطلبات: `order.html`
- لوحة المالك: `admin.html`
- وظائف الخادم: `netlify/functions/`
- جلسات المصادقة: `session-core.js` مع أغلفة المالك والعميل
- التخزين: Netlify Blobs

## المتغيرات المطلوبة
ضع القيم السرية في Netlify Environment Variables فقط:

- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET` (مستحسن؛ إذا غاب يستخدم النظام `ADMIN_PASSWORD` كتوقيع جلسة احتياطي)
- `CLIENT_SESSION_SECRET` (أو استخدام `ADMIN_SESSION_SECRET` كبديل)
- `OPENAI_API_KEY` عند استخدام أدوات OpenAI
- `ANTHROPIC_API_KEY` عند استخدام أدوات Anthropic
- `INTERNAL_SYNC_SECRET` عند استخدام المزامنة الداخلية
- `META_GRAPH_VERSION` عند استخدام تكامل Meta

## النشر
1. ارفع محتويات المشروع إلى مشروع Netlify الحالي.
2. تأكد أن Functions directory هو `netlify/functions`.
3. انشر Production Deploy.
4. اختبر:
   - المالك: Login → Session → Me → Admin
   - العميل: Register/Login → Session → Me → Account
   - إنشاء الطلب بعد تسجيل الدخول
   - تحميل بيانات العميل
   - تسجيل الخروج

## ملاحظة
هذا الملف لا يحتوي على مفاتيح أو أسرار فعلية.
