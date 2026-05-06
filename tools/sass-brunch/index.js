/* eslint camelcase: 0 */
//
// Local TabFern fork of sass-brunch, migrated from the deprecated Legacy JS
// API (`sass.renderSync`) to the Modern API (`sass.compileString` /
// `sass.compile`).  The original upstream package
// (https://github.com/brunch/sass-brunch) has been unmaintained since
// November 2021 and still uses the legacy API which Dart Sass 2.0 will drop.
//
// Dropped (vs. upstream 3.0.1):
//   - `node-sass-glob-importer` dependency: the project does not use
//     `@import "foo/*"` glob patterns; everything uses `@use`.
//   - `sourceComments` and `sourceMapEmbed` options: not configured in
//     the project's brunch-config.js and not exposed by the modern API
//     in the same form.
//   - `omitSourceMapUrl`: the modern API does not emit a sourceMappingURL
//     comment automatically, so the option is unnecessary.
//
// Preserved: include paths, indented-syntax detection, source maps,
// css-modules support, error formatting.

'use strict';

const sysPath = require('path');
const progeny = require('progeny');
const sass = require('sass');
const anymatch = require('anymatch');

const postcss = require('postcss');
const postcssModules = require('postcss-modules');

const cssModulify = (path, data, map, options) => {
  let json = {};
  const getJSON = (_, _json) => (json = _json); // eslint-disable-line

  return postcss([postcssModules(Object.assign({}, { getJSON }, options))])
    .process(data, { from: path, map })
    .then((x) => {
      const exports = `module.exports = ${JSON.stringify(json)};`;
      return {
        exports,
        data: x.css,
        map: x.map,
      };
    });
};

const sassRe = /\.sass$/;

const formatError = (path, err) => {
  // Modern API errors expose .span (file/line/col) and .sassMessage.
  // Fall back gracefully if shape differs.
  try {
    const span = err.span || {};
    const start = span.start || {};
    const file = span.url ? span.url.toString().replace(/^file:\/\/\/?/, '') : path;
    const loc = `L${(start.line || 0) + 1}:${(start.column || 0) + 1}`;
    const where = file === path ? '' : ` of ${file}.`;
    const message = err.sassMessage || err.message;
    const error = new Error(`${loc}${where}\n${message}`);
    error.name = '';
    return error;
  } catch (doubleError) {
    return err;
  }
};

class SassCompiler {
  constructor(cfg = {}) {
    this.rootPath = cfg.paths.root;
    this.optimize = cfg.optimize;
    this.config = (cfg.plugins && cfg.plugins.sass) || {};
    this.modules = this.config.modules || this.config.cssModules;

    if (this.modules && this.modules.ignore) {
      this.isIgnored = anymatch(this.modules.ignore);
      delete this.modules.ignore;
    } else {
      this.isIgnored = anymatch([]);
    }

    delete this.config.modules;
    delete this.config.cssModules;

    if (
      this.config.options != null &&
      this.config.options.includePaths != null
    ) {
      this.includePaths = this.config.options.includePaths;
    }
  }

  _getLoadPaths(path) {
    let loadPaths = [this.rootPath, sysPath.dirname(path)];
    if (Array.isArray(this.includePaths)) {
      loadPaths = loadPaths.concat(this.includePaths);
    }
    return loadPaths;
  }

  get getDependencies() {
    return progeny({
      rootPath: this.rootPath,
      altPaths: this.includePaths,
      reverseArgs: true,
      globDeps: true,
    });
  }

  async compile(source) {
    const { data, path } = source;
    if (!data.trim().length) return Promise.resolve({ data: '' }); // skip empty source files

    try {
      const result = sass.compileString(source.data, {
        url: new URL(`file:///${source.path.replace(/\\/g, '/')}`),
        syntax: sassRe.test(source.path) ? 'indented' : 'scss',
        style: this.optimize ? 'compressed' : 'expanded',
        loadPaths: this._getLoadPaths(source.path),
        sourceMap: true,
        sourceMapIncludeSources: false,
      });

      const cssText = `${result.css}\n\n`;

      // Modern API returns sourceMap as an object (not a Buffer/string).
      // Brunch expects a JSON-shaped map object.  We:
      //   - normalize source URLs to repo-relative paths (avoid leaking
      //     absolute filesystem paths);
      //   - null out sourcesContent so the inline map matches the upstream
      //     sass-brunch behavior and stays small.  Brunch's map merger may
      //     still re-inline content, but the plugin's own emitted map does
      //     not carry it.
      let map = result.sourceMap;
      if (map) {
        map = Object.assign({}, map);
        if (Array.isArray(map.sources)) {
          map.sources = map.sources.map((src) => {
            const cleaned = src
              .replace(/^file:\/\/\//, '')
              .replace(/^file:\/\//, '');
            return sysPath.relative(this.rootPath, cleaned);
          });
        }
        if (Array.isArray(map.sourcesContent)) {
          map.sourcesContent = map.sourcesContent.map(() => null);
        }
      }

      const params = { data: cssText, map };
      if (this.modules && !this.isIgnored(path)) {
        const moduleOptions = this.modules === true ? {} : this.modules;
        return cssModulify(path, params.data, params.map, moduleOptions);
      }

      return params;
    } catch (error) {
      throw formatError(source.path, error);
    }
  }
}

SassCompiler.prototype.brunchPlugin = true;
SassCompiler.prototype.type = 'stylesheet';
SassCompiler.prototype.pattern = /\.s[ac]ss$/;

module.exports = SassCompiler;
