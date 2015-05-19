/*
	Monitor NodeJS application and it's dependencies for changes, autoreload when needed

	Written by Vladimir Neverov <sanguini@gmail.com> in 2015

	GitHub: https://github.com/vne/reqmon

	Usage:
		require('reqmon').watch();

	This call will monitor files of all modules that are loaded after that, including the dependencies of dependencies.
	This is achieved by hooking into Module's prototype and replacing Module.prototype.require. The original 'require'
	method is renamed to 'reqmon_require'.
 */

var DEFAULT_TIMEOUT = 2000;     // milliseconds, timeout
var DEFAULT_DEBUG = false;

var Module = require('module');
var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var path = require('path');

var paths = {};                 // full paths to loaded modules are stored here
var timeouts = {};              // timeouts to block reloading for TIMEOUT ms after change, file names are keys

var TIMEOUT = DEFAULT_TIMEOUT;
var DEBUG = DEFAULT_DEBUG;

var evbus = new EventEmitter();

evbus.unwatch = function() {
	Module.prototype.require = Module.prototype.reqmon_require;
	delete Module.prototype.reqmon_require;
	delete Module.prototype.reqmon_load;
	delete Module.prototype.reqmon_monitor;
	delete Module.prototype.reqmon_change;
	delete Module.prototype.reqmon_fileHasChanged;
	delete Module.prototype.reqmon_timeoutFor;
	delete Module.prototype.reqmon_defaults;
	return evbus;
}

evbus.watch = function(options) {
	// do not setup reqmon more than once
	if (Module.prototype.reqmon_require) { return; }

	// save original require method
	Module.prototype.reqmon_require = Module.prototype.require;

	// override original require with reqmon version
	Module.prototype.require = function(fpath) {
		// determine prefix to required module
		// This prefix is needed because the real require function is called by reqmon instead of the originating module
		// reqmon is located someplace else, so the relative path to the module would be different
		var mfpath = fpath;
		if (module.parent) {
			var caller = getCallingModule();
			if (!paths[caller.filename]) {
				return this.reqmon_require(fpath);
			}
			// console.log('module parent', module.parent.filename, '/for/', fpath, Object.keys(paths));
			// determine the prefix
			var prefix = path.relative(path.dirname(module.filename), path.dirname(module.parent.filename));
			// join the prefix and the path that was originally required
			mfpath = path.join(prefix, fpath);
			// if a relative path was required, add ./ from the left (TODO: think)
			if (fpath.indexOf('./') === 0) {
				mfpath = './' + mfpath;
			}
		}

		// Resolve module path. If the resolve throws an error, then try to resolve the original name.
		// This is needed for built-in modules (like 'http') to work correctly.
		var rpath;
		try {
			rpath = require.resolve(mfpath);
		} catch(e) {
			rpath = require.resolve(fpath);
		}

		// If reqmon is required by reqmon (e.g., on main file reload), reset options to defaults and return
		// module from cache
		// reqmon can not be reloaded by reqmon :)
		if (rpath === module.filename) {
			this.reqmon_defaults();
			return require.cache[rpath].exports;
		}

		// if the resolved path does not start from /, then it is passed directly to the original require
		if (rpath.charAt(0) !== '/') { return this.reqmon_require(fpath); }
		if (DEBUG) { console.log('reqmon:require', rpath, !!module.parent); }

		// require module
		var mod = this.reqmon_load(rpath);

		// setup monitoring
		this.reqmon_monitor(rpath);

		// return module object
		return mod;
	}

	// forced module load (clear cache and then load)
	Module.prototype.reqmon_load = function(rpath) {
		if (DEBUG) { console.log('reqmon:load', rpath); }
		if (require.cache[rpath] && require.cache[rpath].exports.reqmon_on_file_change) {
			require.cache[rpath].exports.reqmon_on_file_change();
		}
		delete require.cache[rpath];
		var mod = this.reqmon_require(rpath);
		evbus.emit('loaded', rpath, mod);
		return mod;
	};

	// monitor module file for changes, call reqmon_change when module is modified
	Module.prototype.reqmon_monitor = function(rpath) {
		var self = this;
		if (paths[rpath]) { return; }
		paths[rpath] = true;
		if (DEBUG) { console.log('reqmon:monitor', rpath); }
		fs.watch(rpath, { persistent: false, recursive: false })
			.on('change', function(ev) { return self.reqmon_change(ev, rpath); })
			.on('error', function(err) { console.error('reqmon:error', err); });
	};

	// module change handler that reloads the module if reqmon_fileHasChanged returns true
	Module.prototype.reqmon_change = function(ev, filename) {
		var self = this;
		if (!this.reqmon_fileHasChanged(filename)) { return; }
		if (DEBUG) { console.log('reqmon:change', filename); }
		evbus.emit('change', filename);
		this.reqmon_load(filename);
	};

	// check, whether module should be reloaded
	// TODO: add file mtime comparison
	Module.prototype.reqmon_fileHasChanged = function(filename) {
		if (timeouts[filename]) { return false; }
		this.reqmon_timeoutFor(filename);
		return true;
	};

	// setup timeout for file name
	Module.prototype.reqmon_timeoutFor = function(filename) {
		timeouts[filename] = setTimeout(function() { delete timeouts[filename]; }, TIMEOUT);
	};

	// reset options to defaults
	Module.prototype.reqmon_defaults = function() {
		TIMEOUT = DEFAULT_TIMEOUT;
		DEBUG = DEFAULT_DEBUG;
	}

	if (module.parent) {
		module.parent.reqmon_monitor(module.parent.filename);
		// module.parent.reqmon_timeoutFor(module.parent.filename);
	}

	return evbus;
}

evbus.timeout = function(tm) {
	TIMEOUT = tm;
	return evbus;
};
evbus.debug = function(nd) {
	DEBUG = nd;
	return evbus;
};
evbus.list = function() {
	return Object.keys(paths);
}

module.exports = exports = evbus;


// the following code is adopted from
// http://stackoverflow.com/questions/13227489/how-can-one-get-the-file-path-of-the-caller-function-in-node-js
function getCallingModule() {
  var stack = getStack()
  // Remove superfluous function calls on stack
  stack.shift() // getCaller --> getStack
  stack.shift() // omfg --> getCaller
  return stack.filter(function(x) { return !!x.receiver.filename })[0].receiver;
}

function getStack() {
  // Save original Error.prepareStackTrace
  var origPrepareStackTrace = Error.prepareStackTrace
  // Override with function that just returns `stack`
  Error.prepareStackTrace = function (_, stack) { return stack; }
  // Create a new `Error`, which automatically gets `stack`
  var err = new Error()
  // Evaluate `err.stack`, which calls our new `Error.prepareStackTrace`
  var stack = err.stack
  // Restore original `Error.prepareStackTrace`
  Error.prepareStackTrace = origPrepareStackTrace
  // Remove superfluous function call on stack
  stack.shift() // getStack --> Error
  return stack
}

