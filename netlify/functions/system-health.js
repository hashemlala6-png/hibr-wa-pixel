'use strict';

const { getStore, connectLambda } = require('@netlify/blobs');
const { env } = require('./env');
const { requireAdmin, json } = require('./auth-utils');
const { configuredProviders, requestText } = require('./ai-provider');

const clean = (value, max = 180) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const has = (...names) => names.filter(name => Boolean(env(name))).length;
const stateOf = (present, total) => present === total ? 'configured' : present > 0 ? 'partial' : 'missing';

function configuration() {
  const providers = configuredProviders();
  const imageConfigured = Boolean(env('OPENAI_API_KEY'));
  const igAppFields = has('INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_REDIRECT_URI');
  const cloudinaryFields = has('CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET');
  const emailFields = has('RESEND_API_KEY', 'LEADS_NOTIFY_EMAIL', 'LEADS_FROM_EMAIL');
  const ownerWhatsAppFields = has('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_NAME') + 1; // leads.js has a server-side fallback recipient.
  const clientWhatsAppFields = has('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_CLIENT_APPROVAL_TEMPLATE_NAME');
  return {
    aiText: {
      state: providers.length ? 'configured' : 'missing',
      providers: providers.map(item => ({ provider: item.provider, model: item.model })),
      primary: providers[0]?.provider || null,
      note: providers.length ? 'المفاتيح موجودة؛ يلزم اختبار طلب حقيقي قبل اعتبار التوليد عاملاً.' : 'أضيفي OPENAI_API_KEY أو ANTHROPIC_API_KEY.'
    },
    aiImages: {
      state: imageConfigured ? 'configured' : 'missing',
      model: env('OPENAI_IMAGE_MODEL') || 'gpt-image-2',
      targetSize: '1024x1280 (4:5)',
      note: imageConfigured ? 'مفتاح OpenAI موجود؛ لم يُختبر توليد صورة حقيقية.' : 'توليد الصور يحتاج OPENAI_API_KEY.'
    },
    instagram: {
      state: igAppFields === 3 ? 'configured' : igAppFields ? 'partial' : 'missing',
      configuredFields: igAppFields,
      requiredFields: 3,
      note: 'إعداد التطبيق لا يثبت نجاح OAuth أو صلاحيات Instagram.'
    },
    cloudinary: {
      state: stateOf(cloudinaryFields, 3),
      configuredFields: cloudinaryFields,
      requiredFields: 3,
      note: 'اكتمال المفاتيح لا يثبت نجاح رفع ملف.'
    },
    email: {
      state: stateOf(emailFields, 3),
      configuredFields: emailFields,
      requiredFields: 3,
      note: 'تحتاج القناة اختبار إرسال فعلي؛ قبول المزوّد لا يثبت وصول الرسالة.'
    },
    ownerWhatsApp: {
      state: stateOf(ownerWhatsAppFields, 4),
      configuredFields: ownerWhatsAppFields,
      requiredFields: 4,
      recipientSource: env('WHATSAPP_OWNER_NUMBER') ? 'environment' : 'server_default',
      note: 'رقم الاستقبال إما من متغير البيئة أو القيمة الافتراضية بالخادم؛ يلزم قالب معتمد واختبار استلام فعلي.'
    },
    clientWhatsApp: {
      state: stateOf(clientWhatsAppFields, 3),
      configuredFields: clientWhatsAppFields,
      requiredFields: 3,
      note: 'قناة موافقة العميل تحتاج قالب Meta معتمداً واختباراً فعلياً.'
    }
  };
}

async function checkPersistentState() {
  const checkedAt = new Date().toISOString();
  let storage;
  try {
    const page = await getStore({ name: 'hbpx-leads', consistency: 'eventual' }).list({ prefix: 'lead-', limit: 1 });
    storage = { state: 'operational', checkedAt, note: 'نجح اتصال Netlify Blobs وقراءة فهرس الطلبات.' , sampleCount: (page.blobs || []).length };
  } catch (error) {
    storage = { state: 'error', checkedAt, note: 'تعذر الوصول إلى مخزن الطلبات: ' + clean(error.message, 160) };
  }

  let instagram;
  try {
    const connection = await getStore({ name: 'hbpx-instagram-login', consistency: 'eventual' })
      .get('agency-instagram', { type: 'json' });
    if (connection?.token && connection?.profile) {
      const expires = connection.expiresAt ? new Date(connection.expiresAt) : null;
      const expired = expires && Number.isFinite(expires.getTime()) && expires.getTime() <= Date.now();
      instagram = {
        state: expired ? 'expired' : 'linked_unverified',
        username: clean(connection.profile.username, 80),
        expiresAt: connection.expiresAt || null,
        verifiedAt: connection.lastVerifiedAt || null,
        note: expired ? 'الرمز المخزن يبدو منتهي الصلاحية؛ أعيدي الربط أو التحديث.' : 'يوجد رمز مخزن؛ هذا الفحص لا يستدعي Instagram ولا يثبت صلاحية الرمز أو الصلاحيات.'
      };
    } else {
      instagram = { state: 'not_connected', note: 'لم يُعثر على اتصال Instagram محفوظ.' };
    }
  } catch (error) {
    instagram = { state: 'error', note: 'تعذر قراءة اتصال Instagram المحفوظ: ' + clean(error.message, 160) };
  }

  let latestAiTest = null;
  try {
    latestAiTest = await getStore({ name: 'hbpx-system-health', consistency: 'strong' })
      .get('latest-ai-text-test', { type: 'json' });
  } catch {}

  return { checkedAt, storage, instagram, latestAiTest };
}

exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const denied = requireAdmin(event);
  if (denied) return denied;

  try {
    if (event.httpMethod === 'GET') {
      const [configured, persistent] = await Promise.all([
        Promise.resolve(configuration()),
        checkPersistentState()
      ]);
      return json(200, {
        checkedAt: new Date().toISOString(),
        configuration: configured,
        persistent,
        policy: {
          secretsReturned: false,
          configurationDoesNotEqualOperationalProof: true,
          externalPublishingOrMessagingPerformed: false
        }
      });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'بيانات الاختبار غير صالحة.' }); }
    if (body.action !== 'test_text_ai') return json(400, { error: 'إجراء الاختبار غير معروف.' });

    const configured = configuration().aiText;
    if (configured.state !== 'configured') return json(503, { error: configured.note, test: { state: 'not_run' } });

    const started = Date.now();
    try {
      const result = await requestText({
        systemPrompt: 'أنت فاحص اتصال. أجب بكلمة عربية واحدة فقط.',
        userPrompt: 'اكتب كلمة: جاهز',
        maxTokens: 20,
        timeoutMs: 20000
      });
      const item = {
        state: 'operational',
        testedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        provider: result.provider,
        model: result.model,
        fallbackUsed: result.fallbackUsed,
        note: 'استجاب مزوّد النصوص لطلب اختبار قصير. هذا لا يختبر الصور أو Instagram أو الرسائل.'
      };
      let saved = false;
      try {
        await getStore({ name: 'hbpx-system-health', consistency: 'strong' }).setJSON('latest-ai-text-test', item);
        saved = true;
      } catch {}
      return json(200, { test: item, saved, output: result.text.slice(0, 60) });
    } catch (error) {
      const item = {
        state: 'error',
        testedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        note: clean(error.message, 500)
      };
      try { await getStore({ name: 'hbpx-system-health', consistency: 'strong' }).setJSON('latest-ai-text-test', item); } catch {}
      return json(502, { error: item.note, test: item });
    }
  } catch (error) {
    return json(500, { error: 'تعذر قراءة حالة النظام: ' + clean(error.message, 240) });
  }
};
