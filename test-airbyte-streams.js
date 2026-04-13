require('dotenv/config');
async function run() {
  const url = process.env.AIRBYTE_API_URL.replace(/\s+/g, '').replace('api/v1', 'api/public/v1');
  const token = await fetch(process.env.AIRBYTE_API_URL.replace(/\s+/g, '') + '/applications/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.AIRBYTE_CLIENT_ID, client_secret: process.env.AIRBYTE_CLIENT_SECRET })
  }).then(r => r.json()).then(d => d.access_token);
  
  const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
  
  const res = await fetch(url + '/connections/4aad6cb9-15d5-4c59-963f-c3f11a8de1af', {
    method: 'PATCH', headers: h,
    body: JSON.stringify({
      configurations: {
        streams: [ { name: "invoices", syncMode: "full_refresh_append" } ]
      }
    })
  });
  console.log(res.status, await res.text());
}
run();
