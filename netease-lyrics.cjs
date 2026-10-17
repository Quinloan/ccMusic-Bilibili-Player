// Native cloud-search protocol. No personal login cookie or developer API key.
// Protocol reference: NeteaseCloudMusicApiEnhanced module/cloudsearch.js, util/crypto.js.
const { createHash, createCipheriv, randomUUID } = require('node:crypto');
const deviceId = randomUUID();
function encodeRequest(route, payload) {
  const text = JSON.stringify(payload);
  const checksum = createHash('md5').update('nobody' + route + 'use' + text + 'md5forencrypt').digest('hex');
  const body = route + '-36cd479b6b5-' + text + '-36cd479b6b5-' + checksum;
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString('hex').toUpperCase();
}
async function searchNeteaseLyrics(phrase, request = fetch, dispatcher, signal) {
  signal?.throwIfAborted();
  const route = '/api/cloudsearch/pc';
  const header = { os: 'osx', appver: '3.1.0', deviceId, requestId: String(Date.now()) };
  const params = encodeRequest(route, { s: phrase, type: 1006, limit: 8, offset: 0, total: true, e_r: false, header });
  const response = await request('https://interface.music.163.com/eapi/cloudsearch/pc', {
    method: 'POST', body: new URLSearchParams({ params }).toString(), dispatcher,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/', Cookie: 'os=osx; appver=3.1.0' },
  });
  if (!response.ok) { const error = new Error('歌词检索 HTTP ' + response.status); error.serviceCode = response.status; throw error; }
  const data = await response.json();
  if (data.code !== 200) {
    const error = new Error('歌词检索接口错误 ' + data.code);
    error.serviceCode = data.code; throw error;
  }
  return data.result?.songs || [];
}
module.exports = { searchNeteaseLyrics, encodeRequest };
