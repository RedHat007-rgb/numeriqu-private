const http = require('http');

const options = {
  hostname: 'localhost',
  port: 8000,
  path: '/api/v1/source_definition_specifications/get',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log(JSON.stringify(JSON.parse(data).connectionSpecification.properties, null, 2));
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(JSON.stringify({
  sourceDefinitionId: '6fd1e833-dd6e-45ec-a727-ab917c5be892'
}));
req.end();
