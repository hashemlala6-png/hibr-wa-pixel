const crypto = require('crypto');
const { env } = require('./env');
const { requireAdmin, json } = require('./auth-utils');

const FOLDER = 'hibr-wa-pixel/instagram';
const clean = (value, max = 100) => String(value == null ? '' : value).trim().slice(0, max);

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const denied = requireAdmin(event);
  if (denied) return denied;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const cloudName = env('CLOUDINARY_CLOUD_NAME');
  const apiKey = env('CLOUDINARY_API_KEY');
  const apiSecret = env('CLOUDINARY_API_SECRET');
  if (!cloudName || !apiKey || !apiSecret) {
    return json(503, {
      error: 'رفع الوسائط غير مهيأ بعد. أضيفي CLOUDINARY_CLOUD_NAME وCLOUDINARY_API_KEY وCLOUDINARY_API_SECRET إلى Netlify.'
    });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'بيانات غير صالحة.' }); }

  const resourceType = clean(body.resourceType, 20);
  if (!['image', 'video'].includes(resourceType)) {
    return json(400, { error: 'نوع الملف غير مدعوم. اختاري صورة أو فيديو.' });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = 'inst_' + timestamp + '_' + crypto.randomBytes(8).toString('hex');
  const signed = {
    folder: FOLDER,
    overwrite: 'false',
    public_id: publicId,
    timestamp: String(timestamp)
  };
  const toSign = Object.keys(signed).sort().map(key => key + '=' + signed[key]).join('&');
  const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');

  return json(200, {
    cloudName,
    apiKey,
    timestamp,
    folder: FOLDER,
    publicId,
    overwrite: false,
    signature,
    resourceType,
    uploadUrl: 'https://api.cloudinary.com/v1_1/' + encodeURIComponent(cloudName) + '/' + resourceType + '/upload',
    expiresAt: new Date((timestamp + 3600) * 1000).toISOString()
  });
};
