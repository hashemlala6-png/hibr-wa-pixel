'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function makePlan(count) {
  return Array.from({ length: count }, (_, index) => ({
    slide: index + 1,
    visual_description_english: 'A refined premium editorial product scene, uncluttered composition ' + (index + 1),
    overlay_text_arabic: 'فكرة الشريحة ' + (index + 1)
  }));
}

function loadCarousel({ plan, expectedKey = 'openai-test' }) {
  const resolved = require.resolve('../netlify/functions/generate-carousel-images');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const calls = [];
  const writes = [];
  const activity = [];
  const modules = {
    '@netlify/blobs': { connectLambda(event) { calls.push({ kind: 'connectLambda', event }); } },
    './env': { env(name) {
      if (name === 'OPENAI_API_KEY') return expectedKey;
      if (name === 'OPENAI_IMAGE_MODEL') return 'gpt-image-2';
      return '';
    } },
    './auth-utils': {
      requireAdmin() { return null; },
      json(statusCode, body, headers = {}) { return { statusCode, body: JSON.stringify(body), headers }; }
    },
    './ai-context': {
      async getAIContext() { return { client: { activity: 'studio' }, memory: {} }; },
      contextPrompt() { return ''; },
      async saveAIHistory(item) { writes.push(item); }
    },
    './client-activity': { async logActivity(id, type, label, details) { activity.push({ id, type, label, details }); } },
    './ai-provider': {
      async requestText() { return { text: JSON.stringify(plan), provider: 'openai', model: 'gpt-6-luna', fallbackUsed: false }; }
    }
  };
  Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === resolved && modules[request]) return modules[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const handler = require(resolved).handler;
    return { handler, calls, writes, activity };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; }, async text() { return JSON.stringify(body); } };
}
function body(result) { return JSON.parse(result.body || '{}'); }

test('carousel generates portrait 4:5 JPEG images with GPT Image 2', async () => {
  const service = loadCarousel({ plan: makePlan(2) });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return response(200, { data: [{ b64_json: 'IMAGE_' + requests.length }] });
  };
  try {
    const result = await service.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ clientId: 'client-a', activity: 'studio', topic: 'campaign', slideCount: 2 })
    });
    const data = body(result);
    assert.equal(result.statusCode, 200);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.body.model, 'gpt-image-2');
      assert.equal(request.body.size, '1024x1280');
      assert.equal(request.body.quality, 'high');
      assert.equal(request.body.output_format, 'jpeg');
      assert.equal(Object.hasOwn(request.body, 'response_format'), false);
    }
    assert.equal(data.generatedSlides, 2);
    assert.equal(data.requestedSlides, 2);
    assert.equal(data.slides[0].image_base64, 'data:image/jpeg;base64,IMAGE_1');
    assert.equal(data.slides[1].size, '1024x1280');
    assert.equal(service.writes[0].metadata.generatedImages, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('invalid or incomplete slide plans stop before paid image generation', async () => {
  const service = loadCarousel({ plan: [{ slide: 1, visual_description_english: 'only one', overlay_text_arabic: '' }] });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return response(200, { data: [{ b64_json: 'unexpected' }] }); };
  try {
    const result = await service.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ clientId: 'client-a', topic: 'campaign', slideCount: 3 })
    });
    assert.equal(result.statusCode, 500);
    assert.equal(calls, 0);
    assert.equal(service.writes.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('carousel slide count is clamped to six before requesting generated images', async () => {
  const service = loadCarousel({ plan: makePlan(6) });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return response(200, { data: [{ b64_json: 'x' }] }); };
  try {
    const result = await service.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ clientId: 'client-a', topic: 'campaign', slideCount: 99 })
    });
    const data = body(result);
    assert.equal(result.statusCode, 200);
    assert.equal(calls, 6);
    assert.equal(data.requestedSlides, 6);
    assert.equal(data.generatedSlides, 6);
  } finally {
    global.fetch = originalFetch;
  }
});

test('partial image provider failures are reported per slide and not counted as generated', async () => {
  const service = loadCarousel({ plan: makePlan(2) });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 2) return response(429, { error: { message: 'rate limited' } });
    return response(200, { data: [{ b64_json: 'first' }] });
  };
  try {
    const result = await service.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ clientId: 'client-a', topic: 'campaign', slideCount: 2 })
    });
    const data = body(result);
    assert.equal(result.statusCode, 200);
    assert.equal(data.generatedSlides, 1);
    assert.equal(data.slides[1].image_base64, undefined);
    assert.match(data.slides[1].error, /429/);
    assert.equal(service.writes[0].metadata.generatedImages, true);
    assert.equal(service.writes[0].metadata.failedSlides, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
