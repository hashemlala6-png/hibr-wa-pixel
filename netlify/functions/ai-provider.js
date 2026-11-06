'use strict';

const { env } = require('./env');

const clean = (value, max = 320) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

function configuredProviders() {
  const openaiKey = env('OPENAI_API_KEY');
  const anthropicKey = env('ANTHROPIC_API_KEY');
  const preferred = clean(env('AI_PRIMARY_PROVIDER'), 20).toLowerCase();
  const order = preferred === 'anthropic'
    ? ['anthropic', 'openai']
    : preferred === 'openai'
      ? ['openai', 'anthropic']
      : (openaiKey ? ['openai', 'anthropic'] : ['anthropic', 'openai']);

  return order
    .filter((provider, index, list) => list.indexOf(provider) === index)
    .map(provider => ({
      provider,
      apiKey: provider === 'openai' ? openaiKey : anthropicKey,
      model: provider === 'openai'
        ? (env('OPENAI_TEXT_MODEL') || 'gpt-6-luna')
        : (env('ANTHROPIC_TEXT_MODEL') || env('ANTHROPIC_MODEL') || 'claude-sonnet-4-6')
    }))
    .filter(item => Boolean(item.apiKey));
}

function hasTextProvider() {
  return configuredProviders().length > 0;
}

function shouldFallback(error) {
  const message = String(error && error.message || '').toLowerCase();
  if (/(credit balance|insufficient[_ ](quota|credit|balance)|billing|quota exceeded|rate limit|overloaded|temporarily unavailable)/i.test(message)) return true;
  if (!error || error.status == null) return true;
  return [402, 408, 409, 425, 429, 500, 502, 503, 504, 529].includes(Number(error.status));
}

async function readPayload(response) {
  try { return await response.json(); } catch { return {}; }
}

function extractText(provider, payload) {
  if (provider === 'openai') {
    if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
    const output = Array.isArray(payload.output) ? payload.output : [];
    return output
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(item => item && (item.type === 'output_text' || typeof item.text === 'string'))
      .map(item => typeof item.text === 'string' ? item.text : '')
      .join('\n').trim();
  }
  return (Array.isArray(payload.content) ? payload.content : [])
    .filter(item => item && item.type === 'text')
    .map(item => typeof item.text === 'string' ? item.text : '')
    .join('\n').trim();
}

async function requestProvider(item, options) {
  const maxTokens = Math.max(1, Math.min(12000, Number(options.maxTokens) || 1000));
  const timeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(Math.max(1000, Math.min(90000, Number(options.timeoutMs) || 45000)))
    : undefined;

  let url, headers, body;
  if (item.provider === 'openai') {
    url = 'https://api.openai.com/v1/responses';
    headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + item.apiKey };
    body = {
      model: item.model,
      instructions: String(options.systemPrompt || ''),
      input: String(options.userPrompt || ''),
      max_output_tokens: maxTokens
    };
  } else {
    url = 'https://api.anthropic.com/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': item.apiKey,
      'anthropic-version': '2023-06-01'
    };
    body = {
      model: item.model,
      max_tokens: maxTokens,
      system: String(options.systemPrompt || ''),
      messages: [{ role: 'user', content: String(options.userPrompt || '') }]
    };
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(timeoutSignal ? { signal: timeoutSignal } : {})
    });
  } catch (cause) {
    const error = new Error(item.provider + ' تعذر الاتصال بالمزوّد: ' + clean(cause && cause.message || 'خطأ شبكة'));
    error.provider = item.provider;
    error.status = null;
    throw error;
  }

  const payload = await readPayload(response);
  if (!response.ok || payload.error) {
    const detail = payload.error && (payload.error.message || payload.error.type)
      || payload.message
      || response.statusText
      || 'فشل طلب المزوّد';
    const error = new Error(item.provider + ' (HTTP ' + response.status + '): ' + clean(detail));
    error.provider = item.provider;
    error.status = response.status;
    throw error;
  }

  const text = extractText(item.provider, payload);
  if (!text) {
    const error = new Error(item.provider + ' أعاد استجابة بلا نص قابل للاستخدام.');
    error.provider = item.provider;
    error.status = 502;
    throw error;
  }
  return { text, provider: item.provider, model: item.model };
}

async function requestText(options = {}) {
  const providers = configuredProviders();
  if (!providers.length) {
    throw new Error('لا يوجد مزوّد نصوص مهيأ. أضيفي OPENAI_API_KEY أو ANTHROPIC_API_KEY إلى متغيرات Netlify.');
  }

  const failures = [];
  for (let index = 0; index < providers.length; index++) {
    const item = providers[index];
    try {
      const result = await requestProvider(item, options);
      return { ...result, fallbackUsed: index > 0, attemptedProviders: [...failures.map(x => x.provider), item.provider] };
    } catch (error) {
      failures.push({ provider: item.provider, message: clean(error.message), status: error.status });
      if (index === providers.length - 1 || !shouldFallback(error)) break;
    }
  }

  const summary = failures.map(x => x.message).join(' | ');
  throw new Error('تعذر توليد النص من مزودي الذكاء الاصطناعي. ' + clean(summary, 900));
}

module.exports = { requestText, hasTextProvider, configuredProviders };
