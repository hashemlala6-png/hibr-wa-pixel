const { env } = require('./env');
// Netlify Function: يحمي مفتاح Claude API بالكامل عن الزوار
// المفتاح يُقرأ من متغير بيئة (Environment Variable) مخزّن بإعدادات Netlify، وليس بالكود

const { requireAdmin, json } = require('./auth-utils');
const { getAIContext, contextPrompt, saveAIHistory } = require('./ai-context');
const { logActivity } = require('./client-activity');

exports.handler = async function (event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "same-origin",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const auth = requireAdmin(event);
  if (auth) return auth;

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "المفتاح غير مضبوط بإعدادات السيرفر (Environment Variables)" }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "بيانات غير صالحة" }) };
  }

  const { mode, topic, tone, textType, colors, font, slideCount } = payload;
  const clientId = String(payload.clientId || '').trim();
  const clientContext = await getAIContext(clientId);
  const memory = clientContext?.memory || {};
  const activity = String(payload.activity || clientContext?.client?.activity || '').trim();
  const audience = String(payload.audience || memory.audience || '').trim();
  const effectiveColors = String(colors || memory.brand || '').trim();
  const effectiveFont = String(font || '').trim();

  if (mode === "analysis") {
    if (!topic) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "الصق بيانات المنشورات أولاً" }),
      };
    }
  } else if (!activity || !topic) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "أدخل اسم النشاط والموضوع على الأقل" }),
    };
  }

  function buildSystemPrompt() {
    if (mode === "writing") {
      const toneLabels = {
        "1": "رسمية جداً كخطاب حكومي",
        "3": "مهنية لكن دافئة",
        "5": "عفوية جداً كحديث بين أصدقاء",
      };
      const toneLabel = toneLabels[tone] || toneLabels["3"];
      const textTypeVal = textType || "كابشن قصير";
      const formatRules = {
        "كابشن قصير": "5 أسطر بالضبط، ينتهي بدعوة فعل واحدة واضحة",
        "إعلان": "8-10 أسطر، بأسلوب إعلاني مقنع يبرز الفائدة والقيمة، ينتهي بدعوة فعل قوية وواضحة",
        "وصف منتج": "6-8 أسطر، يركز على مواصفات وفوائد المنتج بوضوح، بأسلوب وصفي دقيق، ينتهي بدعوة للاستفسار أو الطلب",
      };
      const formatRule = formatRules[textTypeVal] || formatRules["كابشن قصير"];
      return `أنت كاتب محتوى إعلاني محترف بخبرة بالسوق العراقي، أسلوبك إنساني بحت ولا يشبه نصوص الذكاء الاصطناعي.
النشاط: ${activity}
الجمهور: ${audience || "عام"}
نبرة الصوت: ${toneLabel}
نوع النص المطلوب: ${textTypeVal}
اللهجة: عراقية

قواعد صارمة:
- لا تبدأ بسؤال استفهامي أو كليشيه مثل "هل تشعر أن..."
- ممنوع كلمات: "رحلة"، "استثنائي"، "لا تفوت الفرصة"
- نوّع طول الجمل: جمل قصيرة (أقل من 8 كلمات) وجمل أطول (12+ كلمة)
- اكتب كأنك تحكي لصديق، مو إعلان
- الطول والصيغة: ${formatRule}`;
    }

    if (mode === "design") {
      const colorsVal = effectiveColors || "غير محدد، اقترح ألواناً مناسبة";
      const fontVal = effectiveFont || "خط عربي حديث بدون زخرفة";
      return `أنت مصمم جرافيك محترف، تنتج وصفاً نصياً دقيقاً لتصميم فقط (وليس صورة فعلية)، لأن هذا الوصف سيُستخدم لاحقاً بأداة توليد صور منفصلة.
النشاط: ${activity}
الجمهور: ${audience || "عام"}
الألوان: ${colorsVal}
نوع الخط: ${fontVal}

تجنب تماماً: شرائط ملونة قطرية، دوائر متطايرة عشوائية، إطارات مذهّبة، أيقونات نجوم أو قلوب زخرفية عائمة، القوالب النمطية المستهلكة.

أعطني الوصف بهذا الترتيب:
1. وصف الخلفية بالتفصيل
2. العنصر المركزي وموقعه بالضبط (يسار/وسط/يمين)
3. النص الظاهر على التصميم (كلمات محددة بالعدد، 3-6 كلمات)
4. نسبة الأبعاد المقترحة (1:1 أو 4:5 أو 9:16)`;
    }

    if (mode === "carousel") {
      const count = slideCount || "3";
      return `أنت مصمم جرافيك محترف، تنتج وصفاً نصياً لكاروسيل من ${count} شرائح (وليس صوراً فعلية)، لأن الوصف سيُستخدم لاحقاً بأداة توليد صور منفصلة.
النشاط: ${activity}
الجمهور: ${audience || "عام"}

تجنب تماماً: شرائط ملونة قطرية، دوائر متطايرة عشوائية، إطارات مذهّبة، القوالب النمطية المستهلكة.

المطلوب: وصف منفصل ومرقم لكل شريحة من الـ ${count} شرائح، بحيث تشكل قصة متسلسلة ومنطقية (مثال: مشكلة → حل → دعوة، أو خطوة بخطوة). لكل شريحة أعطِ:
- رقم الشريحة
- وصف الخلفية والعنصر المركزي
- النص الظاهر (كلمات محددة بالعدد)
حافظ على نفس نسبة الأبعاد (1:1) ونفس الهوية البصرية عبر كل الشرائح لضمان الاتساق.`;
    }

    // analysis
    return `أنت محلل تسويقي رقمي محترف، متخصص باستنتاج الأسباب الجذرية وراء نجاح أو فشل المحتوى، مو فقط وصف الأنماط.

البيانات (كل منشور: النص/الوصف، نوع الصورة، تاريخ ووقت النشر، مستوى التفاعل):
${topic}

تجنب تماماً:
اختلاق وقت ذروة أو سبب جذري إذا كانت البيانات غير كافية — قل ذلك صراحة بدل التخمين. وصف "شنو" حصل بدون تفسير "ليش". ملاحظات عامة تنطبق على أي حساب.

حلل البيانات أعلاه وأجب بالترتيب:
1. وقت الذروة: أي ساعة/يوم تكرر فيه التفاعل الأعلى؟
2. سبب النجاح: لأعلى 2-3 منشورات، ليش نجحت تحديداً (العنصر النفسي/السلوكي، لا وصف سطحي)؟
3. سبب الفشل: لأضعف 2-3 منشورات، ليش فشلت تحديداً؟
4. المقارنة: ما العنصر الأكثر تكراراً الذي يفرّق بين المجموعتين؟

أعطني تقريراً من 4 نقاط، كل نقطة سطرين كحد أقصى، وينتهي بتوصية عملية واحدة محددة.`;
  }

  function buildUserMessage() {
    if (mode === "writing") return `اكتب كابشن عن: ${topic}`;
    if (mode === "design") return `صف تصميماً عن: ${topic}`;
    if (mode === "carousel") return `صف كاروسيل عن: ${topic}`;
    return `حلل بيانات الحساب أعلاه.`;
  }

  const memoryBlock = contextPrompt(clientContext);
  const baseSystemPrompt = buildSystemPrompt();
  const finalSystemPrompt = `${baseSystemPrompt}${memoryBlock}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: mode === "carousel" ? 1200 : mode === "analysis" ? 900 : 500,
        system: finalSystemPrompt,
        messages: [{ role: "user", content: buildUserMessage() }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        statusCode: response.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: `خطأ من Anthropic: ${response.status}`, details: errText }),
      };
    }

    const data = await response.json();
    const text = (data.content || []).map((b) => b.text || "").join("\n");

    if (clientId) {
      await saveAIHistory({ clientId, mode, topic, input: JSON.stringify({ activity, audience, tone, textType, colors: effectiveColors, font: effectiveFont, slideCount }), output: text, metadata: { continuedFromMemory: true } });
      await logActivity(clientId, 'ai', `AI — ${mode === 'writing' ? 'كتابة محتوى' : mode === 'design' ? 'وصف تصميم' : mode === 'analysis' ? 'تحليل حساب' : 'كاروسيل'}`, { topic: String(topic).slice(0,500), mode, memoryApplied: !!clientContext });
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ text, clientId, memoryApplied: !!clientContext }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
