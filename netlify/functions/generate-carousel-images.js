const { env } = require('./env');
// Netlify Function: يولّد وصف شرائح الكاروسيل عبر Claude، ثم صور فعلية
// لكل شريحة عبر DALL-E (OpenAI). المفاتيح تُقرأ من متغيرات البيئة فقط.

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

  const anthropicKey = env('ANTHROPIC_API_KEY');
  const openaiKey = env('OPENAI_API_KEY');

  if (!anthropicKey || !openaiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: !openaiKey
          ? "مفتاح OPENAI_API_KEY غير مضبوط بإعدادات السيرفر"
          : "مفتاح ANTHROPIC_API_KEY غير مضبوط بإعدادات السيرفر",
      }),
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
  const count = parseInt(slideCount || "3", 10);

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
  try {
    const planResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system: planningSystemPrompt,
        messages: [{ role: "user", content: `صف كاروسيل عن: ${topic}` }],
      }),
    });

    if (!planResponse.ok) {
      const errText = await planResponse.text();
      return {
        statusCode: planResponse.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: `خطأ من Claude: ${planResponse.status}`, details: errText }),
      };
    }

    const planData = await planResponse.json();
    const rawText = (planData.content || []).map((b) => b.text || "").join("\n").trim();
    // تنظيف بسيط لو رجع النص محاط بـ ```json
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    slidesPlan = JSON.parse(cleaned);
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "تعذر تحليل خطة الشرائح من Claude", details: err.message }),
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
    await saveAIHistory({ clientId, mode: 'carousel', topic, input: JSON.stringify({ activity, audience, colors, font, slideCount }), output: JSON.stringify(slidesPlan), metadata: { generatedImages: true, slideCount: results.length, continuedFromMemory: true } });
    await logActivity(clientId, 'ai', 'AI — كاروسيل + صور', { topic: String(topic).slice(0,500), mode:'carousel', generatedImages:true, memoryApplied:!!clientContext });
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ slides: results, clientId, memoryApplied: !!clientContext }),
  };
};
