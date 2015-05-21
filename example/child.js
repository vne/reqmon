var reqmon = require('../reqmon').watch();
var grandchild = require('./grandchild');

console.log('child loaded');

module.exports = function() {
	grandchild.apply(null, arguments);
}
