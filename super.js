var assemble   = require('assemble');
var async      = require('async');
var exec       = require('child_process').exec;
var fs         = require('fs');
var glob       = require('glob');
var handlebars = require('handlebars');
var hljs       = require('highlight.js');
var jsdoc      = require('jsdoc3-parser');
var marked     = require('marked');
var path       = require('path');
var rimraf     = require('rimraf');
var sassdoc    = require('sassdoc');

handlebars.registerHelper('toUpper', function(str) {
  return str[0].toUpperCase() + str.slice(1);
});

handlebars.registerHelper('writeMixin', function(mixin) {
  var name = mixin['context']['name'];
  var params = mixin['parameter'];

  var str = '@mixin ';
  str += name + '(';
  for (var i in params) {
    str += '$' + params[i]['name'] + ', ';
  }
  str = str.slice(0, -2);
  str += ') { }';

  return str;
});

// Creates a new instance of Supercollider, which will generate a single static site.
// options: an object of configuration settings:
//   - html: directory to scan for HTML
//   - sass: directory to scan for Sass
//   - js: directory to scan for JavaScript
//   - dest: directory to output the test JSON to
var Super = function(options) {
  var _this = this;
  this.options = options;
}

Super.prototype = {
  // Parses files according to the options passed to the constructor.
  parseFiles: function() {
    var _this = this;
    var tasks = [
      // Hologram
      function(callback) {
        exec('bundle exec ruby lib/hologram.rb ' + _this.options.html, function(error, stdout, stderr) {
          callback(error, JSON.parse(stdout));
        });
      },
      // SassDoc
      function(callback) {
        sassdoc.parse(_this.options.sass, {verbose: true}).then(function(data) {
          callback(null, data);
        });
      },
      // JSDoc
      function(callback) {
        glob(_this.options.js, function(er, files) {
          var data = [];
          for (var file in files) {
            jsdoc(files[file], function(error, ast) {
              for (var item in ast) data.push(ast[item]);
            });
          }
          callback(null, data);
        });
      }
    ];

    async.parallel(tasks, function(err, results) {
      _this.process(results);
    });
  },

  // Combines the data from multiple parsing trees into one object.
  // data: an array containing data from different parsers, generated by the async library. Each item in the array is an object containing the output of a single parser.
  process: function(data) {
    var hologram = data[0][0];
    var sassdoc  = data[1];
    var jsdoc    = data[2];
    var tree = {};

    // Process Hologram components
    // The Hologram parser forms the "canonical" list of components
    for (var item in hologram) {
      var comp = hologram[item];
      var componentName = comp['blocks'][0]['name'];
      var html = marked(comp['md'], {
        highlight: function(code, lang) {
          return hljs.highlight(lang, code).value;
        }
      });

      tree[componentName] = {
        'html': html,
        'variable': [],
        'mixin': [],
        'function': [],
        'javascript': []
      }
    }

    // Process SassDoc components
    // The @group tag is used to connect items to the main object
    for (var item in sassdoc) {
      var comp = sassdoc[item];
      var group = comp['group'][0];
      var type  = comp['context']['type'];

      if (typeof tree[group] === 'object') {
        // Type will be "function", "mixin", or "variable"
        tree[group][type].push(comp);
      }
      else {
        console.warn("Found a Sass component missing HTML documentation: " + group);
      }
    }

    // Process JSDoc components
    // The @component tag is used to connect items to the main object
    for (var item in jsdoc) {
      var comp = jsdoc[item];

      // Find the component name
      var group = (function() {
        for (var tag in comp['tags']) {
          if (comp['tags'][tag]['title'] === 'component') return comp['tags'][tag]['value'];
        }
        return null;
      })();

      if (group === null) {
        console.warn("Found a JavaScript doclet missing a component name: " + comp['kind'] + " " + comp['name']);
      }
      else {
        if (typeof tree[group] === 'object') {
          tree[group]['javascript'].push(comp);
        }
        else {
          console.warn("Found a JavaScript component missing HTML documentation: " + group);
        }
      }
    }

    fs.writeFile(this.options.destJSON, JSON.stringify(tree));
    this.buildPages(tree);
  },

  // Creates HTML pages out of an object of components, and writes them to disk.
  // tree: an object of components generated by Super.process().
  buildPages: function(tree) {
    // Fetch template code
    var layoutSrc = fs.readFileSync('templates/layout.html');
    var componentSrc = fs.readFileSync('templates/component.html')

    // Compile it into Handlebars templates
    var layoutTemplate = handlebars.compile(layoutSrc.toString(), {noEscape: true});
    var componentTemplate = handlebars.compile(componentSrc.toString(), {noEscape: true});

    // Erase an existing build folder and recreate it
    if (fs.existsSync(this.options.dest)) {
      rimraf.sync(this.options.dest)
    }
    fs.mkdirSync(this.options.dest);

    var components = Object.keys(tree);

    // For each component in the list, render a template with that component's data and write it to disk
    for (var name in tree) {
      var data = tree[name];

      // Compile the page
      var componentPage = componentTemplate(data);
      var layoutPage    = layoutTemplate({body: componentPage, components: components});

      // Write to disk
      fs.writeFileSync(path.join(this.options.dest, name+'.html'), layoutPage);
    }
  }
}

module.exports = function(options) {
  var s = new Super(options);
  s.parseFiles();
}