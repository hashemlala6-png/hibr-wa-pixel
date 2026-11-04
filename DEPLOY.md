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

## تشخيص دخول المالك في Deploy Preview

تسجيل دخول المالك يقارن كلمة المرور المدخلة مع متغير Netlify السري `ADMIN_PASSWORD` حرفياً. لا توجد كلمة مرور افتراضية أو كلمة مرور محفوظة داخل ملفات المستودع.

- `ADMIN_PASSWORD`: مطلوب فعلياً لقبول كلمة المرور.
- `ADMIN_SESSION_SECRET`: يُفضّل ضبطه لتوقيع جلسة المالك؛ لا يُستخدم ككلمة مرور الدخول.
- يجب أن تكون المتغيرات متاحة لنطاق **Functions** وأن تشمل سياق **Deploy Previews** عند اختبار رابط المعاينة.
- إذا كان للمتغير قيمة منفصلة في Production وDeploy Previews، فيجب أن تكون قيمة المعاينة هي كلمة المرور التي ستُستخدم على رابط المعاينة.
- بعد تعديل المتغيرات في Netlify، أعد بناء/نشر المعاينة حتى تدخل التغييرات حيّز التنفيذ.

رسائل التشخيص:
- `كلمة المرور غير صحيحة.`: متغير `ADMIN_PASSWORD` موجود، لكن القيمة المدخلة لا تطابقه.
- `إعداد دخول المالك ناقص في Netlify.`: متغير `ADMIN_PASSWORD` غير متاح لهذا السياق.
- `محاولات كثيرة. حاول بعد دقائق.`: أوقف محدد المحاولات الدخول مؤقتاً؛ انتظر انتهاء نافذة الحماية قبل إعادة المحاولة.

لا تضع كلمة المرور أو مفاتيح الجلسات في GitHub أو في `netlify.toml` أو رسائل المحادثة.

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
