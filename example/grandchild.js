var http = module.require('http');

console.log('grandchild loaded');

module.exports = function() {
	http.createServer().listen(34567);
	console.log('grandchild: server is listening on port 34567');
}
module.exports.reqmon_on_file_change = function() {
	console.log('grandchild: file has changed!');
}

