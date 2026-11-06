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

- `ADMIN_PASSWORD` — كلمة مرور المالك في Production وDeploy Previews.
- `ADMIN_SESSION_SECRET` (مستحسن؛ إذا غاب يستخدم النظام كلمة مرور المالك كتوقيع جلسة احتياطي)
- `CLIENT_SESSION_SECRET` (أو استخدام `ADMIN_SESSION_SECRET` كبديل)
- `OPENAI_API_KEY` عند استخدام أدوات OpenAI
- `ANTHROPIC_API_KEY` عند استخدام أدوات Anthropic
- `INTERNAL_SYNC_SECRET` عند استخدام المزامنة الداخلية
- `META_GRAPH_VERSION` عند استخدام تكامل Meta

## دخول المالك في Deploy Preview

تستخدم Production ومعاينات Deploy Previews كلمة مرور المالك نفسها من المتغير `ADMIN_PASSWORD`. لا تحتاج إلى إنشاء `ADMIN_PREVIEW_PASSWORD` أو إعداد كلمة مرور ثانية.

تبقى جلسات المعاينة معزولة تشفيرياً عن جلسات Production، ولا يؤدي استخدام كلمة المرور نفسها إلى قبول جلسة معاينة على الموقع الأساسي أو العكس. هذا يحافظ على توقيعات جلسات Production الحالية دون تغيير.

- يجب أن يكون `ADMIN_PASSWORD` متاحاً لوظائف Netlify ضمن سياق Production وDeploy Previews.
- إذا كان المتغير مضبوطاً على Production فقط، أضف له قيمة Deploy Previews نفسها من إعدادات Netlify (من دون إنشاء متغير جديد).
- `ADMIN_SESSION_SECRET` مستحسن لتوقيع الجلسات؛ لا يُستخدم وحده ككلمة مرور دخول.
- بعد تعديل متغيرات Netlify، أعد بناء/نشر المعاينة حتى تدخل التغييرات حيّز التنفيذ.

رسائل التشخيص:
- `كلمة المرور غير صحيحة.`: المتغير `ADMIN_PASSWORD` موجود، لكن القيمة المدخلة لا تطابقه.
- `إعداد دخول المالك ناقص...`: لم تصل قيمة `ADMIN_PASSWORD` إلى Functions في سياق النشر الحالي.
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
