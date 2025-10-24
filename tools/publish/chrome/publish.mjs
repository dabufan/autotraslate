
// tools/publish/chrome/publish.mjs
// Usage: node tools/publish/chrome/publish.mjs <zipPath>
// Env required:
//   CWS_EXTENSION_ID
//   CWS_CLIENT_ID
//   CWS_CLIENT_SECRET
//   CWS_REFRESH_TOKEN
import fs from 'fs';
import path from 'path';
import https from 'https';

function postForm(url, data) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(data).toString();
    const u = new URL(url);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function request(opts, stream) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', reject);
    if (stream) stream.pipe(req); else req.end();
  });
}

async function getAccessToken() {
  const {
    CWS_CLIENT_ID,
    CWS_CLIENT_SECRET,
    CWS_REFRESH_TOKEN
  } = process.env;
  const tokenUrl = 'https://www.googleapis.com/oauth2/v4/token';
  const { status, body } = await postForm(tokenUrl, {
    client_id: CWS_CLIENT_ID,
    client_secret: CWS_CLIENT_SECRET,
    refresh_token: CWS_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  if (status !== 200) throw new Error('Token error: ' + body);
  return JSON.parse(body).access_token;
}

async function uploadZip(accessToken, zipPath, extensionId) {
  const stat = fs.statSync(zipPath);
  const u = new URL(`https://www.googleapis.com/upload/chromewebstore/v1.1/items/${extensionId}`);
  const opts = {
    method: 'PUT',
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'x-goog-api-version': '2',
      'Content-Type': 'application/zip',
      'Content-Length': stat.size
    }
  };
  const stream = fs.createReadStream(zipPath);
  const res = await request(opts, stream);
  if (res.status !== 200) throw new Error('Upload error: ' + res.body);
  console.log('Upload OK:', res.body);
}

async function publish(accessToken, extensionId) {
  const u = new URL(`https://www.googleapis.com/chromewebstore/v1.1/items/${extensionId}/publish`);
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'x-goog-api-version': '2',
      'Content-Length': 0
    }
  };
  const res = await request(opts);
  if (res.status !== 200) throw new Error('Publish error: ' + res.body);
  console.log('Publish OK:', res.body);
}

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('Usage: node tools/publish/chrome/publish.mjs <zipPath>');
    process.exit(1);
  }
  const { CWS_EXTENSION_ID } = process.env;
  if (!CWS_EXTENSION_ID) throw new Error('CWS_EXTENSION_ID missing in env.');
  const token = await getAccessToken();
  await uploadZip(token, zipPath, CWS_EXTENSION_ID);
  await publish(token, CWS_EXTENSION_ID);
}

main().catch(e => { console.error(e); process.exit(1); });
