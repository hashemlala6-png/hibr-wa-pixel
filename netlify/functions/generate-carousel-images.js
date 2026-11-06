const { env } = require('./env');
const { requestText } = require('./ai-provider');
const { connectLambda } = require('@netlify/blobs');
// Netlify Function: يولّد وصف شرائح الكاروسيل عبر Claude، ثم صور فعلية
// لكل شريحة عبر DALL-E (OpenAI). المفاتيح تُقرأ من متغيرات البيئة فقط.

const { requireAdmin, json } = require('./auth-utils');
const { getAIContext, contextPrompt, saveAIHistory } = require('./ai-context');
const { logActivity } = require('./client-activity');

exports.handler = async event => {
  connectLambda(event);
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

  const openaiKey = env('OPENAI_API_KEY');
  if (!openaiKey) {
    return {
      statusCode: 503,
      headers: corsHeaders,
      body: JSON.stringify({ error: "مفتاح OPENAI_API_KEY غير مضبوط؛ يلزم لتوليد صور الشرائح." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "بيانات غير صالحة" }) };
  }

  const clientId = String(payload.clientId || '').trim();
  if (!clientId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "اختر العميل أولاً." }) };
  const clientContext = await getAIContext(clientId);
  const memory = clientContext?.memory || {};
  const activity = String(payload.activity || clientContext?.client?.activity || '').trim();
  const audience = String(payload.audience || memory.audience || '').trim();
  const colors = String(payload.colors || memory.brand || '').trim();
  const font = String(payload.font || '').trim();
  const { topic, slideCount } = payload;
  const requestedCount = Number.parseInt(slideCount || "3", 10);
  const count = Number.isFinite(requestedCount) ? Math.max(2, Math.min(6, requestedCount)) : 3;

  if (!activity || !topic) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "أدخل اسم النشاط والموضوع على الأقل" }),
    };
  }

  // 1) نطلب من Claude أوصاف الشرائح بصيغة JSON منظمة لضمان سهولة الاستخدام
  const planningSystemPrompt = `أنت مصمم جرافيك محترف. صف كاروسيل من ${count} شرائح لحملة سوشيال ميديا.
النشاط: ${activity}
الجمهور: ${audience || "عام"}
الألوان: ${colors || "غير محدد، اقترح ألواناً مناسبة"}
الخط: ${font || "خط عربي حديث بدون زخرفة"}

أعد الإجابة بصيغة JSON فقط، بدون أي نص إضافي قبله أو بعده، بهذا الشكل بالضبط:
[
  {"slide": 1, "visual_description_english": "...", "overlay_text_arabic": "..."},
  {"slide": 2, "visual_description_english": "...", "overlay_text_arabic": "..."}
]

قواعد مهمة:
- visual_description_english: وصف بصري بالإنجليزية (للاستخدام مع أداة توليد صور)، يصف الخلفية والعنصر المركزي فقط، بدون طلب كتابة أي نص داخل الصورة نفسها
- overlay_text_arabic: النص العربي القصير (3-6 كلمات) الذي سيُضاف يدوياً فوق الصورة لاحقاً، وليس جزءاً من طلب توليد الصورة
- الشرائح تشكل قصة متسلسلة ومنطقية بنفس الهوية البصرية عبر كل شريحة
- تجنب تماماً: شرائط ملونة قطرية، دوائر متطايرة عشوائية، إطارات مذهّبة، القوالب النمطية المستهلكة
${contextPrompt(clientContext)}`;

  let slidesPlan;
  let planningProvider = null;
  try {
    const completion = await requestText({
      systemPrompt: planningSystemPrompt,
      userPrompt: `صف كاروسيل عن: ${topic}`,
      maxTokens: 1200
    });
    planningProvider = completion.provider;
    const cleaned = completion.text.replace(/```json|```/g, "").trim();
    slidesPlan = JSON.parse(cleaned);
    if (!Array.isArray(slidesPlan) || slidesPlan.length !== count) {
      throw new Error(`يجب أن تعود خطة الكاروسيل بعدد ${count} شرائح بالضبط.`);
    }
    slidesPlan = slidesPlan.map((slide, index) => ({
      slide: index + 1,
      visual_description_english: String(slide.visual_description_english || "").trim().slice(0, 1800),
      overlay_text_arabic: String(slide.overlay_text_arabic || "").trim().slice(0, 180)
    }));
    if (slidesPlan.some(slide => !slide.visual_description_english || !slide.overlay_text_arabic)) {
      throw new Error("إحدى الشرائح تفتقد الوصف البصري أو النص العربي.");
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "تعذر إعداد خطة الشرائح. لم يبدأ توليد الصور.", details: err.message }),
    };
  }

  // 2) نولّد صورة فعلية لكل شريحة عبر DALL-E
  const results = [];
  for (const slide of slidesPlan) {
    const imagePrompt = `${slide.visual_description_english}. Professional social media poster background, clean minimal composition, no text, no letters, no words in the image, high quality, studio lighting.`;

    try {
      const imgResponse = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "dall-e-3",
          prompt: imagePrompt,
          n: 1,
          size: "1024x1024",
          response_format: "b64_json",
        }),
      });

      if (!imgResponse.ok) {
        const errText = await imgResponse.text();
        results.push({
          slide: slide.slide,
          overlay_text_arabic: slide.overlay_text_arabic,
          error: `فشل توليد صورة الشريحة ${slide.slide}: ${imgResponse.status}`,
          details: errText,
        });
        continue;
      }

      const imgData = await imgResponse.json();
      const b64 = imgData.data && imgData.data[0] && imgData.data[0].b64_json;

      results.push({
        slide: slide.slide,
        overlay_text_arabic: slide.overlay_text_arabic,
        image_base64: b64 ? `data:image/png;base64,${b64}` : null,
      });
    } catch (err) {
      results.push({ slide: slide.slide, error: err.message });
    }
  }

  if (clientId) {
    await saveAIHistory({ clientId, mode: 'carousel', topic, input: JSON.stringify({ activity, audience, colors, font, slideCount }), output: JSON.stringify(slidesPlan), metadata: { generatedImages: true, slideCount: results.length, continuedFromMemory: true, planningProvider } });
    await logActivity(clientId, 'ai', 'AI — كاروسيل + صور', { topic: String(topic).slice(0,500), mode:'carousel', generatedImages:true, memoryApplied:!!clientContext });
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ slides: results, clientId, memoryApplied: !!clientContext, planningProvider, requestedSlides: count, generatedSlides: results.filter(x => x.image_base64).length }),
  };
};
