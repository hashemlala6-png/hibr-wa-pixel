const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { env } = require('./env');
const { requireAdmin, json } = require('./auth-utils');
const { logActivity } = require('./client-activity');
const { blobOptions } = require('./blob-config');

const CONTENT_STORE = 'hbpx-instagram-content';
const CONNECTION_STORE = 'hbpx-instagram-login';
const CONTENT_PREFIX = 'post-';
const CONNECTION_KEY = 'agency-instagram';
const API_VERSION = env('INSTAGRAM_API_VERSION') || 'v26.0';

function store(name) {
  return getStore(blobOptions(name, 'eventual'));
}

async function acquirePublishLock(itemId) {
  const locks = store('hbpx-instagram-publish-locks');
  const key = 'lock-' + itemId;
  const token = crypto.randomBytes(18).toString('hex');
  const now = Date.now();
  const lock = { token, acquiredAt: now, expiresAt: now + 120000 };

  const current = await locks.getWithMetadata(key, { consistency: 'strong', type: 'json' });
  if (!current) {
    const created = await locks.setJSON(key, lock, { onlyIfNew: true });
    // Some SDK failure paths can report modified=true without a real ETag.
    // A successful provider write must include its ETag; fail closed otherwise.
    return created.modified && created.etag ? { acquired: true, key, token } : { acquired: false };
  }
  const data = current.data || {};
  if (Number(data.expiresAt) > now) return { acquired: false, expiresAt: data.expiresAt };

  const replaced = await locks.setJSON(key, lock, { onlyIfMatch: current.etag });
  return replaced.modified && replaced.etag ? { acquired: true, key, token } : { acquired: false };
}

async function releasePublishLock(lock) {
  if (!lock?.acquired) return;
  try {
    const locks = store('hbpx-instagram-publish-locks');
    const current = await locks.getWithMetadata(lock.key, { consistency: 'strong', type: 'json' });
    if (!current || current.data?.token !== lock.token) return;
    const released = await locks.setJSON(lock.key, {
      token: '',
      acquiredAt: 0,
      expiresAt: 0,
      releasedAt: Date.now()
    }, { onlyIfMatch: current.etag });
    if (released.modified && !released.etag) {
      console.error('Instagram publish lock release was not confirmed by an ETag; the lease will expire naturally.');
    }
  } catch (error) {
    console.error('Instagram publish lock release failed', error?.message || error);
  }
}

async function publishingQuota(accountId, token) {
  const data = await graph(accountId + '/content_publishing_limit', token, 'GET', {
    fields: 'quota_usage,config'
  });
  const row = Array.isArray(data.data) ? data.data[0] : null;
  const usage = Number(row?.quota_usage);
  const total = Number(row?.config?.quota_total);
  const duration = Number(row?.config?.quota_duration);
  if (!row || !Number.isFinite(usage) || !Number.isFinite(total) || total <= 0) {
    throw new Error('لم تُرجع Meta بيانات حصة النشر. أوقفنا النشر احتياطياً حتى نتحقق من الحد الفعلي للحساب.');
  }
  return {
    usage,
    total,
    remaining: Math.max(0, total - usage),
    durationSeconds: Number.isFinite(duration) ? duration : null
  };
}
const clean = (v, n = 500) => String(v == null ? '' : v).trim().slice(0, n);
function decrypt(box) {
  const secret = env('ADMIN_SESSION_SECRET');
  if (!secret) throw new Error('ADMIN_SESSION_SECRET غير مضبوط في Netlify.');
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64url')), decipher.final()]).toString('utf8');
}
function mediaUrl(value, type) {
  let u;
  try { u = new URL(String(value || '')); } catch { throw new Error('أحد روابط الوسائط غير صالح.'); }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) throw new Error('روابط الوسائط يجب أن تكون عامة عبر HTTPS.');
  const path = u.pathname.toLowerCase();
  if (type === 'image' && !/\.(jpe?g)$/.test(path)) {
    throw new Error('Instagram يحتاج صورة JPEG. ارفعي صورة JPG من الاستوديو أو استخدمي رابطاً ينتهي بـ .jpg أو .jpeg.');
  }
  if (type === 'video' && !/\.(mp4|mov|m4v)$/.test(path)) {
    throw new Error('رابط فيديو Reel يجب أن ينتهي بـ MP4 أو MOV أو M4V.');
  }
  return u.toString();
}
async function graph(path, token, method = 'GET', params = {}) {
  const url = new URL('https://graph.instagram.com/' + API_VERSION + '/' + String(path).replace(/^\/+/, ''));
  const init = { method, headers: { Authorization: 'Bearer ' + token } };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  } else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(Object.entries(params).reduce((out, [k, v]) => {
      if (v !== undefined && v !== null) out[k] = String(v);
      return out;
    }, {}));
  }
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error(clean(data.error?.message || 'Instagram API HTTP ' + response.status, 400));
    error.status = response.status;
    error.provider = data.error || null;
    throw error;
  }
  return data;
}
async function readContent(id) {
  return store(CONTENT_STORE).get(id, { type: 'json', consistency: 'strong' });
}
async function saveContent(item) {
  item.updatedAt = new Date().toISOString();
  await store(CONTENT_STORE).setJSON(item.id, item);
}
function publicResult(item) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    format: item.format,
    publishStatus: item.publishStatus || null,
    publishStartedAt: item.publishStartedAt || null,
    publishedAt: item.publishedAt || null,
    instagramMediaId: item.instagramMediaId || null,
    instagramPermalink: item.instagramPermalink || null,
    publishError: item.publishError || null,
    message: item.publishMessage || null
  };
}
async function createContainer(accountId, token, params) {
  const data = await graph(accountId + '/media', token, 'POST', params);
  if (!data.id) throw new Error('لم يُرجع Instagram معرّف حاوية المحتوى.');
  return String(data.id);
}
async function createMediaContainer(item, accountId, token) {
  const urls = Array.isArray(item.mediaUrls) ? item.mediaUrls : [];
  if (item.format === 'IMAGE') {
    if (urls.length !== 1) throw new Error('المنشور المفرد يحتاج صورة JPEG واحدة.');
    const imageUrl = mediaUrl(urls[0], 'image');
    const params = { image_url: imageUrl, caption: clean(item.caption, 2200) };
    if (item.altText) params.alt_text = clean(item.altText, 1000);
    return { containerId: await createContainer(accountId, token, params), childContainerIds: [] };
  }
  if (item.format === 'CAROUSEL') {
    if (urls.length < 2 || urls.length > 10) throw new Error('الكاروسيل يحتاج من صورتين إلى 10 صور JPEG.');
    const childIds = [];
    for (const raw of urls) {
      const imageUrl = mediaUrl(raw, 'image');
      childIds.push(await createContainer(accountId, token, {
        image_url: imageUrl,
        is_carousel_item: 'true'
      }));
    }
    // Carousel children need to finish processing before the parent container
    // is created. Persist these IDs so the owner can continue without
    // recreating the media assets or accidentally starting a second attempt.
    return { containerId: null, childContainerIds: childIds };
  }
  if (item.format === 'REEL') {
    if (urls.length !== 1) throw new Error('Reel يحتاج فيديو واحداً.');
    const videoUrl = mediaUrl(urls[0], 'video');
    return {
      containerId: await createContainer(accountId, token, {
        media_type: 'REELS',
        video_url: videoUrl,
        caption: clean(item.caption, 2200),
        share_to_feed: 'true'
      }),
      childContainerIds: []
    };
  }
  if (item.format === 'STORY') {
    throw new Error('نشر Stories غير مفعّل في هذا المسار حالياً. يمكن تجهيزها كمسودة، لكن لا يمكن إرسالها من هذه النسخة.');
  }
  throw new Error('نوع المحتوى غير مدعوم للنشر.');
}
async function createCarouselParent(item, accountId, token) {
  const childIds = Array.isArray(item.instagramChildContainerIds) ? item.instagramChildContainerIds : [];
  if (childIds.length < 2 || childIds.length > 10) throw new Error('معرّفات صور الكاروسيل غير مكتملة.');
  return createContainer(accountId, token, {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption: clean(item.caption, 2200)
  });
}
async function containerStatus(containerId, token) {
  // Meta documents status_code as the supported container readiness field.
  const data = await graph(containerId, token, 'GET', { fields: 'status_code' });
  return {
    status: clean(data.status_code, 40).toUpperCase(),
    message: ''
  };
}
async function publishContainer(accountId, containerId, token) {
  return graph(accountId + '/media_publish', token, 'POST', { creation_id: containerId });
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  connectLambda(event);
  const denied = requireAdmin(event);
  if (denied) return denied;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'بيانات غير صالحة.' }); }
  const id = clean(body.id, 180);
  const action = clean(body.action, 30);
  if (!id || !id.startsWith(CONTENT_PREFIX)) return json(400, { error: 'معرّف المسودة غير صالح.' });
  if (!['start', 'continue'].includes(action)) return json(400, { error: 'الإجراء غير معروف.' });

  const contentStore = store(CONTENT_STORE);
  let item = await contentStore.get(id, { type: 'json', consistency: 'strong' });
  if (!item) return json(404, { error: 'المسودة غير موجودة.' });
  if (item.status !== 'approved') return json(409, { error: 'لا يمكن النشر إلا بعد اعتماد المسودة من المالكة.' });
  if (item.publishedAt || item.publishStatus === 'published') return json(409, { item: publicResult(item), error: 'هذا المحتوى منشور بالفعل ولا يمكن نشره مرة ثانية.' });
  if (item.publishStatus === 'publishing') {
    return json(409, { item: publicResult(item), error: 'طلب النشر قيد التنفيذ لدى Instagram. لا تضغطي مرة ثانية؛ حدّثي القائمة بعد قليل للتحقق من النتيجة.' });
  }
  if (item.publishStatus === 'publish_uncertain') {
    return json(409, { item: publicResult(item), error: 'انقطع الاتصال أثناء طلب النشر، والنتيجة غير محسومة. تحققي من الحساب يدوياً قبل أي محاولة جديدة لتجنب التكرار.' });
  }
  if (!item.approvedAt || item.approvedBy !== 'owner') {
    return json(409, { error: 'سجل موافقة المالكة غير مكتمل. أعيدي اعتماد المحتوى من استوديو المحتوى.' });
  }

  let publishLock = null;
  try {
    publishLock = await acquirePublishLock(id);
    if (!publishLock.acquired) {
      return json(409, { error: 'هناك طلب نشر آخر يعمل على هذا المحتوى. انتظري حتى ينتهي قبل الضغط مرة ثانية.' });
    }
    const connection = await store(CONNECTION_STORE).get(CONNECTION_KEY, { type: 'json', consistency: 'strong' });
    if (!connection?.token || !connection?.profile?.userId) return json(409, { error: 'حساب Instagram غير مربوط. اربطي الحساب وتحققي منه أولاً.' });
    if (connection.expiresAt && new Date(connection.expiresAt).getTime() < Date.now()) return json(409, { error: 'انتهت صلاحية رمز Instagram. حدّثي الرمز أو أعيدي الربط قبل النشر.' });
    const token = decrypt(connection.token);
    const accountId = String(connection.profile.userId);

    let quota;
    try {
      quota = await publishingQuota(accountId, token);
    } catch (error) {
      return json(502, { item: publicResult(item), error: clean(error.message, 500) });
    }
    if (quota.remaining <= 0) {
      return json(429, {
        item: publicResult(item),
        quota,
        error: 'وصل الحساب إلى حد النشر الحالي لدى Instagram. لم نرسل أمراً جديداً للنشر؛ انتظري تجدد الحصة ثم حاولي مرة أخرى.'
      });
    }

    if (action === 'start') {
      if (item.publishStatus === 'processing') return json(409, { item: publicResult(item), error: 'توجد عملية نشر قيد المعالجة. استخدمي متابعة النشر بدلاً من بدء محاولة جديدة.' });
      item.publishStatus = 'preparing';
      item.publishStartedAt = new Date().toISOString();
      item.publishAttemptId = 'igpub-' + Date.now() + '-' + crypto.randomBytes(5).toString('hex');
      item.publishError = null;
      await saveContent(item);
      try {
        const created = await createMediaContainer(item, accountId, token);
        item.instagramContainerId = created.containerId || null;
        item.instagramChildContainerIds = created.childContainerIds || [];
        item.publishStage = created.childContainerIds?.length ? 'children_processing' : 'parent_processing';
        item.publishStatus = 'processing';
        item.publishMessage = created.childContainerIds?.length
          ? 'تم رفع صور الكاروسيل. ننتظر اكتمال معالجة كل صورة قبل تجهيز المنشور الرئيسي.'
          : 'تم إنشاء حاوية المحتوى لدى Instagram. ننتظر جاهزيتها قبل النشر.';
        await saveContent(item);
      } catch (error) {
        item.publishStatus = 'failed';
        item.publishError = clean(error.message, 500);
        item.publishMessage = 'لم يتم نشر المحتوى. راجعي الخطأ قبل إعادة المحاولة.';
        await saveContent(item);
        return json(502, { item: publicResult(item), error: item.publishError });
      }
    }

    item = await readContent(id);
    if (item.publishStatus !== 'processing') {
      return json(409, { item: publicResult(item), error: 'لا توجد عملية معالجة قيد الانتظار. ابدئي محاولة جديدة فقط بعد مراجعة الحالة السابقة.' });
    }

    if (item.publishStage === 'children_processing') {
      const childIds = Array.isArray(item.instagramChildContainerIds) ? item.instagramChildContainerIds : [];
      if (childIds.length < 2 || childIds.length > 10) {
        item.publishStatus = 'failed';
        item.publishError = 'لم تُحفظ معرّفات صور الكاروسيل بالشكل الصحيح.';
        await saveContent(item);
        return json(409, { item: publicResult(item), error: item.publishError });
      }
      const childStates = await Promise.all(childIds.map(id => containerStatus(id, token).catch(error => ({
        status: 'CHECK_FAILED', message: clean(error.message, 300)
      }))));
      const pendingChild = childStates.find(x => x.status === 'IN_PROGRESS' || x.status === 'PENDING');
      const failedChild = childStates.find(x => !['FINISHED', 'IN_PROGRESS', 'PENDING'].includes(x.status));
      if (failedChild) {
        item.publishStatus = 'failed';
        item.publishError = failedChild.message || ('تعذرت معالجة إحدى صور الكاروسيل: ' + failedChild.status);
        item.publishMessage = 'لم يتم إنشاء المنشور الرئيسي ولم يتم النشر.';
        await saveContent(item);
        return json(409, { item: publicResult(item), error: item.publishError });
      }
      if (pendingChild) {
        item.publishMessage = 'Instagram ما زال يعالج صور الكاروسيل. اضغطي متابعة النشر بعد قليل.';
        await saveContent(item);
        return json(202, { item: publicResult(item), containerStatus: 'CHILDREN_IN_PROGRESS', retryAfterSeconds: 20, message: item.publishMessage });
      }
      try {
        item.instagramContainerId = await createCarouselParent(item, accountId, token);
        item.publishStage = 'parent_processing';
        item.publishMessage = 'اكتملت معالجة الصور وأنشأ Instagram حاوية الكاروسيل الرئيسية. نتحقق من جاهزيتها.';
        await saveContent(item);
      } catch (error) {
        item.publishStatus = 'failed';
        item.publishError = clean(error.message, 500);
        item.publishMessage = 'لم يتم إنشاء الحاوية الرئيسية ولم يتم النشر.';
        await saveContent(item);
        return json(502, { item: publicResult(item), error: item.publishError });
      }
      item = await readContent(id);
    }

    if (!item.instagramContainerId || item.publishStage !== 'parent_processing') {
      return json(409, { item: publicResult(item), error: 'حاوية النشر الرئيسية غير جاهزة للفحص.' });
    }

    let state;
    try {
      state = await containerStatus(item.instagramContainerId, token);
    } catch (error) {
      item.publishMessage = 'تعذر التحقق من جاهزية الحاوية. أعيدي المحاولة بعد قليل؛ لم يصدر أمر النشر.';
      item.publishError = clean(error.message, 500);
      await saveContent(item);
      return json(502, { item: publicResult(item), error: item.publishError });
    }

    if (state.status === 'IN_PROGRESS' || state.status === 'PENDING') {
      item.publishMessage = 'Instagram ما زال يعالج الملف. اضغطي متابعة النشر بعد قليل.';
      item.publishError = null;
      await saveContent(item);
      return json(202, { item: publicResult(item), containerStatus: state.status, retryAfterSeconds: 15, message: item.publishMessage });
    }
    if (state.status !== 'FINISHED') {
      item.publishStatus = 'failed';
      item.publishError = state.message || ('حالة حاوية Instagram: ' + (state.status || 'غير معروفة'));
      item.publishMessage = 'لم يتم النشر لأن Instagram لم يؤكد جاهزية المحتوى.';
      await saveContent(item);
      return json(409, { item: publicResult(item), error: item.publishError });
    }

    // Recheck the live publishing quota immediately before sending media_publish.
    try {
      quota = await publishingQuota(accountId, token);
    } catch (error) {
      item.publishMessage = 'تعذر التحقق من حصة النشر الحالية. لم نرسل أمر النشر؛ أعيدي المحاولة بعد التحقق.';
      item.publishError = clean(error.message, 500);
      await saveContent(item);
      return json(502, { item: publicResult(item), error: item.publishError });
    }
    if (quota.remaining <= 0) {
      item.publishMessage = 'لا توجد حصة نشر متبقية حالياً. الحاوية محفوظة؛ أعيدي المتابعة بعد تجدد حصة Instagram.';
      item.publishError = null;
      await saveContent(item);
      return json(429, { item: publicResult(item), quota, error: item.publishMessage });
    }

    // Persist the in-flight guard before calling media_publish. If the network
    // response is lost, the owner must verify the account manually rather than
    // accidentally publishing the same approved draft twice.
    item.publishStatus = 'publishing';
    item.publishMessage = 'الحاوية جاهزة. يجري إرسال أمر النشر الذي طلبته المالكة.';
    item.publishError = null;
    await saveContent(item);

    let published;
    try {
      published = await publishContainer(accountId, item.instagramContainerId, token);
    } catch (error) {
      item.publishStatus = error.status && error.status < 500 ? 'failed' : 'publish_uncertain';
      item.publishError = clean(error.message, 500);
      item.publishMessage = item.publishStatus === 'publish_uncertain'
        ? 'انقطع الاتصال أثناء إرسال أمر النشر. تحققي من Instagram يدوياً قبل أي إعادة محاولة لتجنب التكرار.'
        : 'رفض Instagram أمر النشر. لم يتم تأكيد النشر.';
      await saveContent(item);
      return json(502, { item: publicResult(item), error: item.publishError });
    }

    if (!published.id) {
      item.publishStatus = 'publish_uncertain';
      item.publishError = 'استجاب Instagram دون إرجاع معرّف المنشور.';
      item.publishMessage = 'تحققي من حساب Instagram يدوياً قبل أي إعادة محاولة.';
      await saveContent(item);
      return json(502, { item: publicResult(item), error: item.publishError });
    }

    item.publishStatus = 'published';
    item.publishStage = 'published';
    item.publishedAt = new Date().toISOString();
    item.instagramChildContainerIds = [];
    item.instagramMediaId = String(published.id);
    item.publishMessage = 'أكد Instagram نشر المحتوى.';
    try {
      const media = await graph(String(published.id), token, 'GET', { fields: 'id,permalink,timestamp,media_type,media_product_type' });
      item.instagramPermalink = /^https:\/\/(www\.)?instagram\.com\//i.test(String(media.permalink || '')) ? media.permalink : null;
      item.publishedAt = media.timestamp || item.publishedAt;
    } catch {}
    await saveContent(item);
    try {
      await logActivity(item.clientId || 'hibr-wa-pixel', 'instagram-publish', 'تم نشر محتوى Instagram بموافقة المالكة', {
        postId: item.id,
        instagramMediaId: item.instagramMediaId,
        format: item.format,
        permalink: item.instagramPermalink || null
      });
    } catch {}
    return json(200, {
      item: publicResult(item),
      published: true,
      message: item.publishMessage
    });
  } catch (error) {
    return json(500, { error: clean(error.message || 'تعذر تنفيذ طلب النشر.', 500) });
  } finally {
    await releasePublishLock(publishLock);
  }
};
