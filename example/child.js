var reqmon = require('../reqmon').debug(false).watch();
var grandchild = require('./grandchild');

console.log('child loaded');

module.exports = function() {
	grandchild.apply(null, arguments);
}
