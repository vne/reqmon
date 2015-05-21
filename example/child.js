var reqmon = require('../reqmon').watch({ reload_children: true });
var grandchild = require('./grandchild');

console.log('child loaded');

module.exports = function() {
	grandchild.apply(null, arguments);
}
