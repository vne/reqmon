# reqmon

Monitor NodeJS main application file and it's dependencies for changes, autoreload when needed

Written by Vladimir Neverov <sanguini@gmail.com> in 2015.

Library relies on mangling Module's prototype, and stack traces for detecting calling module. Use at your own risk!

Usage
=====

The simplest use case:

	require('reqmon').watch();

This will enable monitoring for all dependencies that will be required after **reqmon**. If one of the monitored
files is modified, it is removed from the require cache and reloaded. Only dependencies of the module that required
**reqmon** would be monitored.

Module won't reload more often than once in a period for each file. The default is 2 s. Period can be changed
with **reqmon.timeout(newValue)** call:

	require('reqmon').timeout(500).watch();

Example
=======

See **example** directory for sources.

**main.js**

	var child = require('./child');
	var sister = require('./sister');
	console.log('main loaded');
	child();

**child.js**

	var reqmon = require('../reqmon').watch();
	var grandchild = require('./grandchild');
	console.log('child loaded');
	module.exports = function() {
		grandchild.apply(null, arguments);
	}

**sister.js**

	module.exports = function() {
		console.log('sister.js');
	}

**grandchild.js**

	var http = module.require('http');
	console.log('grandchild loaded');
	module.exports = function() {
		http.createServer().listen(34567);
		console.log('grandchild: server is listening on port 34567');
	};
	module.exports.reqmon_on_file_change = function() {
		console.log('grandchild: file has changed!');
	};


Now, run **main.js**. You'll get the following output:

	grandchild loaded
	child loaded
	main loaded

The webserver is created on port 34567, so the application would not quit. Now, change (e.g., re-save) **child.js**. You'll get:

	grandchild: file has changed!
	grandchild loaded
	child loaded

Now, change **grandchild.js**. You'll get:

	grandchild: file has changed!
	grandchild loaded

Now, change **main.js** or **sister.js**. You won't see any output.

Internals
=========

Internally reqmon works by hacking into Module's prototype. It adds several methods there (reqmon\_require, reqmon\_load,
reqmon\_monitor, reqmon\_change, reqmon\_fileHasChanged, reqmon\_timeoutFor, reqmon\_defaults). **reqmon_require** is
the original **Module.prototype.require** method. Reqmon replaces **Module.prototype.require** with it's own method. All reqmon's
own methods are prefixed with **reqmon\_**, so they shouldn't cause clashes. Anyway, be warned!

Detection of the caller module is done using error stack trace (method is discussed at [StackOverflow](http://stackoverflow.com/questions/13227489/how-can-one-get-the-file-path-of-the-caller-function-in-node-js)).
This is needed to not watch **sister.js** in the example above.

For even more details see the source code.

API
===

  * reqmon.watch() - main method that actually replaces Module.prototype.require and does other setup
  * reqmon.unwatch() - restore Module's prototype, put original **require** to it's place and delete all **reqmon**'s methods
  * reqmon.debug(value) - if value === true, reqmon will output debug information to console
  * reqmon.timeout(value) - set new timeout value (default is 2000 ms)
  * reqmon.list() - return a list of paths that are currently monitored

All methods, except **list**, return the same instance of reqmon, so the calls can be chained:

	reqmon.debug(true).timeout(1000).watch();

Reqmon is itself an instance of **events.EventEmitter**. It emits the following events:

  * 'change' - when the file is changed, but not reloaded yet. Full path to file is passed as event argument.
  * 'loaded' - when the file is reloaded. Path and module object are passed as arguments.

Any module that is monitored by **reqmon** can export **reqmon_on_file_change** function. This function will be called
just before reloading of this module. If any parent module is reloaded, it will also be called.
