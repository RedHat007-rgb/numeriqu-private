require('dotenv').config();
async function test() {
  const tReq = await fetch(process.env.AIRBYTE_API_URL.replace(/\s+/g, '') + '/applications/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.AIRBYTE_CLIENT_ID, client_secret: process.env.AIRBYTE_CLIENT_SECRET })
  });
  const t = await (tReq).json();

  const url = process.env.AIRBYTE_API_URL.replace(/\s+/g, '').replace('api/v1', 'api/public/v1');
  const cReq = await fetch(url + '/connections/4aad6cb9-15d5-4c59-963f-c3f11a8de1af', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t.access_token }
  });
  console.log(await cReq.text());
}
test();
