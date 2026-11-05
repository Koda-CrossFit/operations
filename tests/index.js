'use strict';

// Node 24 treats the argument in `node --test tests/` as a module path, not a folder to search, so
// without this file that command fails before running a single test. `node --test` with no argument
// finds the test files on its own and doesn't pick this one up, so nothing runs twice.

require('./scheduler.test.js');
require('./api.test.js');
require('./site.test.js');
