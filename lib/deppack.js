'use strict';
const sysPath = require('path');
const fs = require('fs');
const detective = require('detective');
const browserResolve = require('browser-resolve');
const requireDefinition = require('commonjs-require-definition');
const each = require('async-each');
const helpers = require('./helpers');

const deepExtend = helpers.deepExtend;

const specialShims = { process: { env: { NODE_ENV: process.env.NODE_ENV } } };
const emptyShims = [
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'https', 'net', 'os', 'path', 'punycode',
  'querystring', 'readline', 'repl', 'string_decoder', 'tls', 'tty', 'url',
  'util', 'vm', 'zlib'
];

const shims = Object.assign(emptyShims.reduce((memo, el) => {
  memo[el] = {};
  return memo;
}, {}), specialShims);

const id = x => x;
const not = f => i => !f(i);

const uniq = list => {
  return Object.keys(list.reduce((obj, _) => {
    if (!obj[_]) obj[_] = true;
    return obj;
  }, {}));
};

const readFile = (path, callback) => {
  return fs.readFile(path, {encoding: 'utf8'}, callback);
};

const getModuleRootPath = path => {
  const split = path.split('/');
  const index = split.lastIndexOf('node_modules');
  return split.slice(0, index + 2).join('/');
};

const getModuleRootName = path => {
  const split = path.split('/');
  const index = split.lastIndexOf('node_modules');
  return split[index + 1];
};

const getModuleMainPath = path => sysPath.dirname(getMainFile(path));
const packageJson = filePath => require(relativeToRoot(filePath, 'package.json'));
const browserMappings = filePath => packageJson(filePath).browser || {};
const relativeToRoot = (filePath, relPath) => sysPath.join(getModuleRootPath(filePath), relPath);

const isRelative = path => path.slice(0, 2) === './';

const globalBrowserMappings = filePath => {
  const brMap = browserMappings(filePath);

  return Object.keys(brMap).filter(not(isRelative)).reduce((newBrMap, key) => {
    const val = brMap[key];
    newBrMap[key] = generateModuleName(relativeToRoot(filePath, val));
    return newBrMap;
  }, {});
};

const expandedFilePath = filePath => {
  const brMap = browserMappings(filePath);

  Object.keys(brMap).filter(isRelative).forEach(key => {
    const val = brMap[key];
    if (filePath === relativeToRoot(filePath, val)) {
      filePath = relativeToRoot(filePath, key);
    }
  });

  return filePath;
};

const isMain = filePath => getMainFile(filePath) === filePath;

const getNewHeader = (moduleName, source, filePath) => {
  const brMap = globalBrowserMappings(filePath);

  const r = isMain(filePath) ? "function(n) { return req(n.replace('./', '" + moduleName + "/')); }" : 'req';

  return `require.register('${moduleName}', function(exports,req,module){
    var require = __makeRequire((${r}), ${JSON.stringify(brMap)});
    ${source}
  });`;
};

const generateModule = (filePath, source) => {
  filePath = expandedFilePath(filePath);
  const rootMod = getModuleRootName(filePath);
  const mn = generateModuleName(filePath);

  return getNewHeader(mn, source, filePath);
};

const generateModuleName = filePath => {
  const rp = getModuleMainPath(filePath);
  const mn = getModuleRootName(filePath) + (isMain(filePath) ? '' : filePath.replace(rp, '').replace('.js', ''));

  return mn;
};

const isDir = fileOrDir => {
  var isDir;
  try { isDir = fs.lstatSync(fileOrDir).isDirectory(); } catch (e) { isDir = false; }
  return isDir;
};

const _mainFile = (root, json) => {
  const depMain = typeof json.browser === 'string' ? json.browser : json.main || 'index.js';
  const fileOrDir = sysPath.join(root, depMain);
  if (isDir(fileOrDir)) {
    return sysPath.join(fileOrDir, 'index.js');
  } else {
    return fileOrDir.indexOf('.js') === -1 ? fileOrDir + '.js' : fileOrDir;
  }
};

const getMainFile = filePath => {
  const root = getModuleRootPath(filePath);
  const json = packageJson(filePath);

  return _mainFile(root, json);
};

const loadFile = (filePath, opts) => new Promise((resolve, reject) => {
  if (opts == null) opts = {};
  if (opts.paths == null) {
    const ref = process.env.NODE_PATH;
    opts.paths = (ref != null ? ref.split(':') : void 0) || [];
  }
  if (opts.basedir == null) opts.basedir = process.cwd();

  const paths = opts.paths.map(path => {
    return sysPath.resolve(opts.basedir, path);
  });
  filePath = sysPath.resolve(opts.basedir, filePath);

  return readFile(filePath, (err, src) => {
    if (err) return reject(err);
    resolve(generateModule(filePath, src));
  });
});

const brunchRe = /brunch/;
const load = (config, json, deps) => new Promise((resolve, reject) => {
  const paths = config.paths;
  const rootPath = sysPath.resolve(paths.root);

  const packages = config.npm.packages || [];
  const exclude = config.npm.exclude || [];

  if (packages.length !== 0 && exclude.length !== 0) {
    return reject('NPM: you cannot specify both config.npm.packages and config.npm.exclude at the same time');
  }

  exclude.push('coffee-script');

  const useExcludes = packages.length === 0;
  const filterFn = (dep) => {
    const isValidName = !brunchRe.test(dep);
    const isSpecified = useExcludes ?
      exclude.indexOf(dep) === -1 :
      packages.indexOf(dep) !== -1;
    return isValidName && isSpecified;
  };

  const items = deps.filter(filterFn).map(dep => {
    const depPath = sysPath.join(rootPath, 'node_modules', dep);
    let depJson = require(sysPath.join(depPath, 'package.json'));
    if (json.overrides != null ? json.overrides[dep] : undefined) {
      depJson = deepExtend(depJson, json.overrides[dep]);
    }

    const file = _mainFile(depPath, depJson);
    return {
      name: dep,
      file: file,
      version: json.dependencies[dep]
    };
  }).filter(id);

  const depReg = {};
  const recordItem = item => depReg[item.file] = item.depPaths;
  const isRegistered = item => Object.keys(depReg).indexOf(item.file) !== -1;

  const resolveDeps = (item, cb) => {
    const res = (i, cb) => browserResolve(i, { filename: item.file }, cb);

    each(item.deps, res, (err, fullPaths) => {
      if (err) return cb(err);
      cb(null, { file: item.file, depPaths: fullPaths });
    });
  };

  const readItem = (item, cb) => readFile(item.file, (err, data) => {
    if (err) return cb(err);
    cb(null, { file: item.file, data: data });
  });

  const detect = i => { return { file: i.file, deps: detective(i.data) }; };

  const resolveItems = (items, cb) => {
    each(items, readItem, (err, redItems) => {
      if (err) return cb(err);

      const wDeps = redItems.map(detect);

      each(wDeps, resolveDeps, (err, resolvedItems) => {
        if (err) return cb(err);

        resolvedItems.forEach(recordItem);

        const toO = file => { return { file: file }; };
        const deps = uniq(resolvedItems.reduce((acc, it) => acc.concat(it.depPaths), []));
        const unresDeps = deps.filter(not(isRegistered)).map(toO);

        if (unresDeps.length === 0) {
          return cb(null);
        }

        resolveItems(unresDeps, cb);
      });
    });
  };

  const reply = (err) => {
    if (err) reject(err);

    const data = Object.keys(depReg).map(file => {
      return { component: getModuleRootName(file), file: file, files: depReg[file] };
    });

    const glob = { component: '*', file: null, files: Object.keys(depReg) };

    const styles = config.npm.styles || {};

    const styleComps = Object.keys(styles).map(pkg => {
      const stylesheets = styles[pkg];
      const root = sysPath.join(rootPath, 'node_modules', pkg);

      return { component: pkg, files: stylesheets.map(style => sysPath.join(root, style)) };
    });

    resolve({ components: data.concat([glob]).concat(styleComps) });
  };

  resolveItems(items, reply);
});

const insertGlobals = (config, root) => {
  const globals = config.npm.globals || {};

  Object.keys(globals).forEach(glob => {
    root.add(`window.${glob} = require('${globals[glob]}');`);
  });
};

const needsProcessing = file => file.path.indexOf('node_modules') !== -1;

const processFiles = (config, root, files, processor) => {
  const shimSts = Object.keys(shims).map(shim => {
    const val = shims[shim];
    const safe = typeof val === 'string' ? val : JSON.stringify(val);
    return `${shim}: (${safe})`;
  });

  root.add(`(function() {
    var global = window;
    var __shims = {${shimSts.join(',')}};
    var process = __shims.process;

    var __makeRequire = function(r, __brmap) {
      return function(name) {
        if (__brmap[name] !== undefined) name = __brmap[name];
        name = name.replace(".js", "");
        return ${JSON.stringify(Object.keys(shims))}.indexOf(name) !== -1 ? __shims[name] :  r(name);
      }
    };
  `);
  files.forEach(processor);
  root.add('})();');

  insertGlobals(config, root);
};

module.exports.loadFile = loadFile;
module.exports.load = load;
module.exports.needsProcessing = needsProcessing;
module.exports.processFiles = processFiles;
