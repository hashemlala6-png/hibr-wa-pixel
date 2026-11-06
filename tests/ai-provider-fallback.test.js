'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadProvider(values) {
  const resolved = require.resolve('../netlify/functions/ai-provider');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === './env' && parent && parent.filename === resolved) {
      return { env(name) { return values[name] || ''; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 400 ? 'Provider error' : 'OK',
    async json() { return payload; }
  };
}

test('OpenAI is the default text provider when configured and returns Responses API text', async () => {
  const provider = loadProvider({ OPENAI_API_KEY: 'openai-secret' });
  const originalFetch = global.fetch;
  let calledUrl = '';
  let requestBody;
  global.fetch = async (url, options) => {
    calledUrl = String(url);
    requestBody = JSON.parse(options.body);
    return response(200, { output_text: 'نص تجريبي صالح' });
  };
  try {
    const result = await provider.requestText({ systemPrompt: 'تعليمات', userPrompt: 'اكتب', maxTokens: 250 });
    assert.equal(calledUrl, 'https://api.openai.com/v1/responses');
    assert.equal(requestBody.model, 'gpt-6-luna');
    assert.equal(requestBody.instructions, 'تعليمات');
    assert.equal(result.text, 'نص تجريبي صالح');
    assert.equal(result.provider, 'openai');
    assert.equal(result.fallbackUsed, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Anthropic credit exhaustion falls back to OpenAI without exposing API keys', async () => {
  const provider = loadProvider({
    AI_PRIMARY_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    OPENAI_API_KEY: 'openai-secret'
  });
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('anthropic.com')) {
      return response(400, { error: { message: 'Your credit balance is too low.' } });
    }
    return response(200, { output_text: 'نتيجة من المزود البديل' });
  };
  try {
    const result = await provider.requestText({ systemPrompt: 'تعليمات', userPrompt: 'اكتب' });
    assert.equal(calls.length, 2);
    assert.equal(result.provider, 'openai');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.text, 'نتيجة من المزود البديل');
    assert.ok(!JSON.stringify(result).includes('secret'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('invalid request errors do not trigger a second paid provider request', async () => {
  const provider = loadProvider({
    AI_PRIMARY_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    OPENAI_API_KEY: 'openai-secret'
  });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return response(400, { error: { message: 'Invalid request body.' } });
  };
  try {
    await assert.rejects(
      provider.requestText({ systemPrompt: 'x', userPrompt: 'y' }),
      /Invalid request body/
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('only Anthropic key is sufficient when OpenAI is not configured', async () => {
  const provider = loadProvider({ ANTHROPIC_API_KEY: 'anthropic-secret' });
  const originalFetch = global.fetch;
  let calledUrl = '';
  global.fetch = async (url) => {
    calledUrl = String(url);
    return response(200, { content: [{ type: 'text', text: 'نص من Claude' }] });
  };
  try {
    const result = await provider.requestText({ systemPrompt: 's', userPrompt: 'u' });
    assert.equal(calledUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.text, 'نص من Claude');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AI status is unavailable when no text provider key exists', async () => {
  const provider = loadProvider({});
  assert.equal(provider.hasTextProvider(), false);
  await assert.rejects(
    provider.requestText({ systemPrompt: 's', userPrompt: 'u' }),
    /لا يوجد مزوّد نصوص مهيأ/
  );
});
