/*
	Monitor NodeJS application and it's dependencies for changes, autoreload when needed

	Written by Vladimir Neverov <sanguini@gmail.com> in 2015

	GitHub: https://github.com/vne/reqmon

	Usage:
		require('reqmon').watch();

	This call will monitor files of all modules that are loaded after that, including the dependencies of dependencies.
	This is achieved by hooking into Module's prototype and replacing Module.prototype.require. The original 'require'
	method is renamed to 'reqmon_require'.

	reqmon emits the following events:
	  - change - module has changed, file path is an argument
	  - loaded - module was reloaded, file path and module instance are the two arguments
 */

var DEFAULT_TIMEOUT = 2000;     // milliseconds, timeout
var DEFAULT_DEBUG   = false;
var DEFAULT_CONSOLE = false;
var DEFAULT_RELOAD_CHILDREN = false;

var Module = require('module');
var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var path = require('path');

var paths = {};                        // full paths to loaded modules are stored here
var ignore = [ /\/node_modules\// ];   // paths to ignore (array of strings, regexes, functions and arrays). Ignore all modules in all node_modules directories by default
var timeouts = {};                     // timeouts to block reloading for TIMEOUT ms after change, file names are keys

var TIMEOUT         = DEFAULT_TIMEOUT;
var DEBUG           = DEFAULT_DEBUG;
var CONSOLE         = DEFAULT_CONSOLE;
var RELOAD_CHILDREN = DEFAULT_RELOAD_CHILDREN;

var reqmon = new EventEmitter();

/**
 * Set the time period during which change events would be ignored for the given file
 *
 * @param  {Number} tm timeout in milliseconds
 * @return {Object}    reqmon instance
 */
reqmon.timeout = function(tm) {
	TIMEOUT = tm;
	return reqmon;
};

/**
 * Set debug flag to the value of the first argument
 *
 * @param  {Boolean} nd debug flag
 * @return {Object}    reqmon instance
 */
reqmon.debug = function(nd) {
	DEBUG = nd;
	return reqmon;
};

/**
 * Set console flag (if true, output paths to the modules that are actually monitored)
 * This flag allows to see what is being monitored omitting the rest of the debug info.
 *
 * @param  {Boolean} c console flag
 * @return {Object}   reqmon instance
 */
reqmon.console = function(c) {
	CONSOLE = c;
	return reqmon;
};

/**
 * Set reload children flag. If it is true, then, reloading of the module
 * will cause reloading of all it's children that are also tracked.
 * False by default.
 *
 * @param  {Boolean} c reload children flag
 * @return {Object}   reqmon instance
 */
reqmon.reload_children = function(c) {
	RELOAD_CHILDREN = c;
	return reqmon;
};

/**
 * Add ignore patterns to the list of ignore patterns.
 * Special case is when null is passed as first argument, which means - reset ignore patterns.
 *
 * @return {Object} reqmon instance
 */
reqmon.ignore = function() {
	var list = Array.prototype.slice.call(arguments, 0);
	if (list[0] === null) {
		ignore = [];
		list.shift();
	}
	if (list.length > 0) {
		ignore = ignore.concat(list);
	}
	return reqmon;
};

/**
 * Return list of full paths to the modules that are being monitored
 *
 * @return {Object} reqmon instance
 */
reqmon.list = function() {
	return Object.keys(paths);
};

/**
 * Stop watching for changes and remove reqmon presence from Module's prototype
 *
 * @return {Object} reqmon instance
 */
reqmon.unwatch = function() {
	// stop watchers
	Object.keys(paths).map(function(x) { paths[x].close() });

	// restore original require
	Module.prototype.require = Module.prototype.reqmon_require;

	// delete reqmon methods
	delete Module.prototype.reqmon_require;
	delete Module.prototype.reqmon_load;
	delete Module.prototype.reqmon_monitor;
	delete Module.prototype.reqmon_change;
	delete Module.prototype.reqmon_file_has_changed;
	delete Module.prototype.reqmon_timeoutFor;
	delete Module.prototype.reqmon_defaults;
	delete Module.prototype.reqmon_ignored;

	return reqmon;
}

/**
 * Install reqmon to Module's prototpye, replace the original NodeJS require with reqmon's version
 *
 * All modules that would be required after call to watch(), will pass through reqmon.
 *
 * @return {Object} reqmon instance
 */
reqmon.watch = function(options) {
	// do not setup reqmon more than once
	if (Module.prototype.reqmon_require) { return reqmon; }

	// process options
	if (typeof options === "undefined") { options = {}; }

	if (typeof options.ignore          !== "undefined") { reqmon.ignore(options.ignore); }
	if (typeof options.debug           !== "undefined") { reqmon.debug(options.debug); }
	if (typeof options.console         !== "undefined") { reqmon.console(options.console); }
	if (typeof options.timeout         !== "undefined") { reqmon.timeout(options.timeout); }
	if (typeof options.reload_children !== "undefined") { reqmon.reload_children(options.reload_children); }

	// save original require method
	Module.prototype.reqmon_require = Module.prototype.require;

	// override original require with reqmon version
	/**
	 * Reqmon require
	 *
	 * This is the replacement for original NodeJS require. It decides, whether the requiring module should
	 * be monitored and either falls back to the original require or setups monitoring.
	 *
	 * Inside the function, 'this' refers to the module that is calling require (the requiring module) and
	 * 'module' refers to reqmon module
	 *
	 * @param  {String} fpath module name, the same syntax and meaning as in the original NodeJS's require
	 * @return {Object}       required module exports
	 */
	Module.prototype.require = function(fpath) {
		// determine if the name of the module that is required (fpath) should be modified.
		// This prefix is needed because the real require function is called by reqmon instead of the originating module
		// reqmon is located someplace else, so the relative path to the module would be different
		var mfpath = fpath;
		if (module.parent) {
			// if module that is calling require is not monitored, then do not monitor it's dependencies
			if (!paths[this.filename]) { return this.reqmon_require(fpath); }

			// if a local module is required (path starts with dot), prefix the path with the directory of the requiring module,
			// so mfpath will contain absolute path to the module
			if (fpath.indexOf('.') === 0) {
				mfpath = path.join(path.dirname(this.filename), fpath);
			}
		}

		// Resolve module path. If the resolve throws an error, fall back to the original require.
		var rpath;
		try {
			rpath = require.resolve(mfpath);
		} catch (e) {
			return this.reqmon_require(fpath);
		}

		// check whether the resolved module path is not in ignore list
		if (this.reqmon_ignored(rpath, ignore)) {
			return this.reqmon_require(mfpath);
		}

		// If reqmon is required by reqmon (e.g., on main file reload), reset options to defaults and return
		// module from cache
		// reqmon can not be reloaded by reqmon :)
		if (rpath === module.filename) {
			return require.cache[rpath].exports;
		}

		// if the resolved path does not start from /, then it is passed directly to the original require
		if (rpath.charAt(0) !== '/') { return this.reqmon_require(fpath); }
		if (DEBUG) { console.log('reqmon:require', rpath, !!module.parent); }

		// print debugging information to the console
		if (CONSOLE) { console.log('reqmon:', this.filename, 'requires "' + fpath + '" ->', rpath); }

		// if the module is already loaded, return the cached version
		if (!RELOAD_CHILDREN && require.cache[rpath]) { return require.cache[rpath].exports; }

		// setup monitoring
		// This should be done prior to requiring the module, as module may has other dependencies,
		// that will not be monitored, if their parent isn't on the monitored paths list.
		this.reqmon_monitor(rpath);

		// require module
		return this.reqmon_load(rpath);
	};

	/**
	 * reqmon_ignored
	 *
	 * Check whether the module path is in the ignore list. Return true, if yes.
	 *
	 * Ignore list can include strings (exact match with ===), regexps, functions (checked path is passed as argument)
	 * and arrays (nested ignore lists, that are processed by the same reqmon_ignored function.
	 *
	 * @param  {String} fpath  module path
	 * @param  {Array} ignore list of conditions (either strings, regexps, functions or arrays)
	 * @return {Boolean}        true if at least one condition matches, false otherwise
	 */
	Module.prototype.reqmon_ignored = function(fpath, ignore) {
		var match = false;
		for (var i in ignore) {
			if (ignore[i].constructor === Array) {
				match = this.reqmon_ignored(fpath, ignore[i]);
			} else if (ignore[i].constructor === Function) {
				match = ignore[i].call(null, fpath);
			} else if (ignore[i].constructor === RegExp) {
				match = ignore[i].test(fpath);
			} else {
				match = ignore[i] === fpath;
			}
			if (match) { break; }
		}
		return match;
	};

	/**
	 * reqmon_load
	 *
	 * Forced module load. First, it calls reqmon_on_file_change function from the module if the latter defines it.
	 * Then it clears the require cache, then - requires module anew.
	 * After that it emits 'loaded' event.
	 *
	 * @param  {String} rpath full path to the module
	 * @return {Object}       module exports
	 */
	Module.prototype.reqmon_load = function(rpath) {
		if (DEBUG) { console.log('reqmon:load', rpath); }
		if (require.cache[rpath] && require.cache[rpath].exports.reqmon_on_file_change) {
			require.cache[rpath].exports.reqmon_on_file_change();
		}
		delete require.cache[rpath];
		var mod = this.reqmon_require(rpath);
		// console.log('  loaded module', rpath, !!mod);
		reqmon.emit('loaded', rpath, mod);
		return mod;
	};

	/**
	 * reqmon_monitor
	 *
	 * Monitor module file for changes, call reqmon_change when module is modified.
	 * Do not monitor the module if it is already monitored.
	 *
	 * Let the program exit if it wants to (persistent = false).
	 *
	 * @param  {String} rpath full path to the module
	 */
	Module.prototype.reqmon_monitor = function(rpath) {
		var self = this;
		if (paths[rpath]) { return; }
		if (DEBUG) { console.log('reqmon:monitor', rpath); }
		paths[rpath] = fs.watch(rpath, { persistent: false, recursive: false })
			.on('change', function(ev) { return self.reqmon_change(ev, rpath); })
			.on('error', function(err) { console.error('reqmon:error', err); });
	};

	/**
	 * reqmon_change
	 *
	 * Change event handler that is called on file change by fs.watch.
	 * It checks whether the module has actually changed and calls reqmon_reload if necessary.
	 * It also emits 'change' event before module reloading.
	 *
	 * @param  {Event} ev       event object
	 * @param  {String} filename full path to the file
	 */
	Module.prototype.reqmon_change = function(ev, filename) {
		var self = this;
		if (!this.reqmon_file_has_changed(filename)) { return; }
		if (DEBUG) { console.log('reqmon:change', filename); }
		if (CONSOLE) { console.log('reqmon: reloading', filename); }
		reqmon.emit('change', filename);
		this.reqmon_load(filename);
	};

	/**
	 * reqmon_file_has_changed
	 *
	 * Returns true if file has really changed and should be reloaded
	 *
	 * TODO: add file mtime comparison
	 *
	 * @param  {String} filename
	 * @return {Boolean}          true if file has changed, false otherwise
	 */
	Module.prototype.reqmon_file_has_changed = function(filename) {
		if (timeouts[filename]) { return false; }
		this.reqmon_timeoutFor(filename);
		return true;
	};

	/**
	 * setup timeout for file name, clear the timeout after the timeout :)
	 *
	 * @param  {String} filename
	 */
	Module.prototype.reqmon_timeoutFor = function(filename) {
		timeouts[filename] = setTimeout(function() { delete timeouts[filename]; }, TIMEOUT);
	};

	/**
	 * reset options to defaults
	 */
	Module.prototype.reqmon_defaults = function() {
		TIMEOUT = DEFAULT_TIMEOUT;
		DEBUG = DEFAULT_DEBUG;
		CONSOLE = DEFAULT_CONSOLE;
		RELOAD_CHILDREN = DEFAULT_RELOAD_CHILDREN;
	}

	if (module.parent) {
		module.parent.reqmon_monitor(module.parent.filename);
		// module.parent.reqmon_timeoutFor(module.parent.filename);
	}

	return reqmon;
}

module.exports = exports = reqmon;
