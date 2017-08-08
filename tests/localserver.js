let http = require('http');
let server = http.createServer(function(request, response) {
	response.writeHead(200, {'Content-Type': 'text/plain'});
	response.end('Test is Ok!\n');
});
server.listen(8010);
console.log('Server running at http://127.0.0.1:8010/');